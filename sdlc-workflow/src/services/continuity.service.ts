import {
  appendFileSync,
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync
} from 'fs';
import { inject, injectable } from 'inversify';
import path from 'path';
import type { IDaemonConfigRepository } from '../repositories/daemon-config.repository';
import type { IDaemonStoreRepository } from '../repositories/daemon-store.repository';
import type { IIssueRepository } from '../repositories/issue.repository';
import type { IProcessDetachRepository } from '../repositories/process-detach.repository';
import type { IRunLockRepository } from '../repositories/run-lock.repository';
import type { IRunStateRepository } from '../repositories/run-state.repository';
import type { ISpecDocRepository } from '../repositories/spec-doc.repository';
import { WORKFLOW_TOKENS } from '../tokens';
import type { DurableWatchRecord, RunState, SpecDocument } from '../types';
import {
  readSuperviseLaunchRecord,
  type SuperviseLaunchRecord
} from '../utils/launch-record';
import { appendMonitorLine } from '../utils/monitor';
import { allTasksMerged } from '../utils/run-completion';
import { commitWatchSignal } from '../utils/watch-wake-commit';
import { escalationTitle } from './escalation.service';

/** Default idle window before a dead-supervisor run is treated as abandoned. */
export const DEFAULT_ABANDONED_SECONDS = 7_200;

/** Lock owner string shared with run-lock races against manual resume. */
export const CONTINUITY_RELAUNCH_LOCK_OWNER = 'continuity-relaunch';

export const MINIMUM_CONTINUITY_TICK_MILLISECONDS = 1_000;

export interface ContinuitySkip {
  runId: string;
  reason: string;
}

export interface ContinuityTickResult {
  scanned: number;
  relaunched: string[];
  skipped: ContinuitySkip[];
}

/**
 * Per-workspace continuity tick (SPEC-PRD-0020-P2 T-01).
 *
 * Scans DaemonConfig.runsDir for unfinished runs whose supervise.pid is dead,
 * and relaunches `--supervise` from launch.json under the run lock. Emits
 * relaunch evidence on the run monitor log and a `supervisor-restarted` wake
 * through the shared durable inbox writer — never a chat session, deploy, or
 * spec-status authorization transition.
 */
export interface IContinuityService {
  /**
   * Arm the loop at `tickSeconds` (daemon `defaultPollSeconds`).
   */
  start(workspaceRoot: string, tickSeconds: number): void;
  /** One scan of runsDir; safe to call from tests without `start`. */
  tick(workspaceRoot: string): Promise<ContinuityTickResult>;
  stop(): void;
}

const readSupervisePid = (runDir: string): number | null => {
  const pidPath = path.join(runDir, 'supervise.pid');
  if (existsSync(pidPath) === false) {
    return null;
  }
  try {
    const raw = readFileSync(pidPath, 'utf-8').trim();
    const pid = Number.parseInt(raw, 10);
    if (Number.isSafeInteger(pid) === false || pid <= 0) {
      return null;
    }
    return pid;
  } catch {
    return null;
  }
};

const listRunIds = (runsDir: string): string[] => {
  if (existsSync(runsDir) === false) {
    return [];
  }
  return readdirSync(runsDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort();
};

const abandonedSeconds = (): number => {
  const raw = process.env.SDLC_ABANDONED_SECONDS;
  if (raw === undefined || raw.trim().length === 0) {
    return DEFAULT_ABANDONED_SECONDS;
  }
  const parsed = Number.parseInt(raw, 10);
  if (Number.isSafeInteger(parsed) === false || parsed <= 0) {
    return DEFAULT_ABANDONED_SECONDS;
  }
  return parsed;
};

const idleSecondsForState = (runsDir: string, runId: string): number => {
  const stateFile = path.join(runsDir, runId, 'state.json');
  try {
    const ageMs = Date.now() - statSync(stateFile).mtimeMs;
    return Math.max(0, Math.floor(ageMs / 1_000));
  } catch {
    return 0;
  }
};

const launchUsable = (launch: SuperviseLaunchRecord): boolean => {
  if (launch.argv.length === 0) {
    return false;
  }
  if (
    launch.execPath.trim().length === 0 ||
    existsSync(launch.execPath) === false
  ) {
    return false;
  }
  if (launch.cwd.trim().length === 0 || existsSync(launch.cwd) === false) {
    return false;
  }
  try {
    return statSync(launch.cwd).isDirectory();
  } catch {
    return false;
  }
};

const continuityWatch = (
  runId: string,
  pollSeconds: number
): DurableWatchRecord => ({
  id: `run-supervisor:${runId}`,
  kind: 'run-supervisor',
  target: { runId },
  pollSeconds,
  createdBy: 'continuity',
  createdAt: new Date().toISOString(),
  resumeContext: { runId }
});

@injectable()
export class ContinuityService implements IContinuityService {
  private _timer: ReturnType<typeof setTimeout> | null = null;
  private _running = false;

  constructor(
    @inject(WORKFLOW_TOKENS.DaemonConfigRepository)
    private readonly _configRepo: IDaemonConfigRepository,
    @inject(WORKFLOW_TOKENS.RunStateRepository)
    private readonly _runStateRepo: IRunStateRepository,
    @inject(WORKFLOW_TOKENS.SpecDocRepository)
    private readonly _specDocRepo: ISpecDocRepository,
    @inject(WORKFLOW_TOKENS.ProcessDetachRepository)
    private readonly _detachRepo: IProcessDetachRepository,
    @inject(WORKFLOW_TOKENS.RunLockRepository)
    private readonly _runLockRepo: IRunLockRepository,
    @inject(WORKFLOW_TOKENS.DaemonStoreRepository)
    private readonly _store: IDaemonStoreRepository,
    @inject(WORKFLOW_TOKENS.IssueRepository)
    private readonly _issueRepo: IIssueRepository
  ) {}

  start(workspaceRoot: string, tickSeconds: number): void {
    if (Number.isSafeInteger(tickSeconds) === false || tickSeconds <= 0) {
      throw new TypeError('Continuity tickSeconds must be a positive integer');
    }
    this.stop();
    this._running = true;
    void this.cycle(workspaceRoot, tickSeconds);
  }

  async tick(workspaceRoot: string): Promise<ContinuityTickResult> {
    const { config } = this._configRepo.load(workspaceRoot);
    const runsDir = config.runsDir;
    const result: ContinuityTickResult = {
      scanned: 0,
      relaunched: [],
      skipped: []
    };
    const runIds = listRunIds(runsDir);
    for (const runId of runIds) {
      result.scanned += 1;
      const skip = this.considerRun(
        workspaceRoot,
        runsDir,
        runId,
        config.defaultPollSeconds
      );
      if (skip === null) {
        result.relaunched.push(runId);
      } else if (
        skip.reason !== 'alive' &&
        skip.reason !== 'no-supervise-pid'
      ) {
        result.skipped.push(skip);
      }
    }
    return result;
  }

  stop(): void {
    this._running = false;
    if (this._timer !== null) {
      clearTimeout(this._timer);
      this._timer = null;
    }
  }

  private async cycle(
    workspaceRoot: string,
    tickSeconds: number
  ): Promise<void> {
    try {
      await this.tick(workspaceRoot);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.error(`[continuity] tick failed: ${detail}`);
    }
    if (this._running === false) {
      return;
    }
    const delay = Math.max(
      MINIMUM_CONTINUITY_TICK_MILLISECONDS,
      tickSeconds * 1_000
    );
    this._timer = setTimeout(
      () => void this.cycle(workspaceRoot, tickSeconds),
      delay
    );
  }

  /**
   * @returns null when relaunched; otherwise a skip reason (including quiet
   * skips like alive / no pid that callers may ignore).
   */
  private considerRun(
    workspaceRoot: string,
    runsDir: string,
    runId: string,
    pollSeconds: number
  ): ContinuitySkip | null {
    const state = this._runStateRepo.load(runsDir, runId);
    if (state === null) {
      return { runId, reason: 'no-state' };
    }

    if (this.isFinished(state, runsDir, runId)) {
      return { runId, reason: 'finished' };
    }

    const pid = readSupervisePid(path.join(runsDir, runId));
    if (pid === null) {
      return { runId, reason: 'no-supervise-pid' };
    }
    if (this._detachRepo.isAlive(pid) === true) {
      return { runId, reason: 'alive' };
    }

    const launch = readSuperviseLaunchRecord(runsDir, runId);
    if (launch === null || launchUsable(launch) === false) {
      return { runId, reason: 'launch-unusable' };
    }

    if (this.hasUnresolvedNeedsHuman(state, launch) === true) {
      return { runId, reason: 'unresolved-blockers' };
    }

    const idle = idleSecondsForState(runsDir, runId);
    if (idle > abandonedSeconds()) {
      return { runId, reason: 'abandoned' };
    }

    return this.relaunch(workspaceRoot, runsDir, runId, launch, pollSeconds);
  }

  private isFinished(state: RunState, runsDir: string, runId: string): boolean {
    const launch = readSuperviseLaunchRecord(runsDir, runId);
    const spec = this.loadSpec(state, launch);
    if (spec === null) {
      return false;
    }
    return allTasksMerged(spec, state);
  }

  private loadSpec(
    state: RunState,
    launch: SuperviseLaunchRecord | null
  ): SpecDocument | null {
    const candidates = [launch?.specPath, state.specPath].filter(
      (value): value is string =>
        typeof value === 'string' && value.trim().length > 0
    );
    for (const specPath of candidates) {
      try {
        return this._specDocRepo.read(specPath);
      } catch {
        // Try the next candidate; absence must not abort the tick.
      }
    }
    return null;
  }

  /**
   * True when the run has recorded exceptions and at least one matching
   * needs-human GitHub issue is still open. A check failure fails open
   * (returns false) so a transient `gh` outage cannot strand relaunches —
   * matching the bash daemon's `|| return 1` probe.
   */
  private hasUnresolvedNeedsHuman(
    state: RunState,
    launch: SuperviseLaunchRecord
  ): boolean {
    if (state.exceptions.length === 0) {
      return false;
    }
    const repoPath = launch.repoPath.trim();
    if (repoPath.length === 0 || existsSync(repoPath) === false) {
      return false;
    }
    const seen = new Set<string>();
    try {
      for (const entry of state.exceptions) {
        const title = escalationTitle(state.runId, entry);
        if (seen.has(title) === true) {
          continue;
        }
        seen.add(title);
        const open = this._issueRepo.findByTitle(repoPath, title);
        if (open !== null) {
          return true;
        }
      }
    } catch {
      return false;
    }
    return false;
  }

  private relaunch(
    workspaceRoot: string,
    runsDir: string,
    runId: string,
    launch: SuperviseLaunchRecord,
    pollSeconds: number
  ): ContinuitySkip | null {
    const runDir = path.join(runsDir, runId);
    let lock;
    try {
      lock = this._runLockRepo.acquire(
        runsDir,
        runId,
        CONTINUITY_RELAUNCH_LOCK_OWNER
      );
    } catch {
      return { runId, reason: 'lock-held' };
    }

    try {
      // Re-check under the lock so a racing resume that won the lock earlier
      // cannot be duplicated after we reclaim / after it wrote a new pid.
      const pidAgain = readSupervisePid(runDir);
      if (pidAgain !== null && this._detachRepo.isAlive(pidAgain) === true) {
        return { runId, reason: 'alive' };
      }

      const monitorPath = path.join(runDir, 'monitor.log');
      const logPath = path.join(runDir, 'supervise.log');
      const { pid } = this._detachRepo.spawnDetached({
        command: launch.execPath,
        args: [...launch.execArgv, ...launch.argv],
        cwd: launch.cwd,
        logPath,
        env: {
          ...process.env,
          SDLC_SUPERVISE_MONITOR: monitorPath
        }
      });
      writeFileSync(path.join(runDir, 'supervise.pid'), `${pid}\n`);

      const line = `[continuity] relaunched supervisor as pid ${pid}`;
      appendMonitorLine(monitorPath, line);
      try {
        appendFileSync(logPath, `${line}\n`);
      } catch {
        // Monitor line is the required evidence; supervise.log is best-effort.
      }

      commitWatchSignal(
        this._store,
        workspaceRoot,
        continuityWatch(runId, pollSeconds),
        {
          id: `supervisor-restarted:${runId}:${pid}`,
          observedAt: new Date().toISOString(),
          prompt: `The SDLC supervisor for ${runId} had died and the continuity daemon restarted it (pid ${pid}). Check the run status and confirm it is making progress.`,
          data: { runId, pid, signal: 'supervisor-restarted' }
        }
      );
      return null;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return { runId, reason: `relaunch-failed:${detail}` };
    } finally {
      this._runLockRepo.release(lock);
    }
  }
}
