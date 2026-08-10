import {
  appendFileSync,
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync
} from 'fs';
import { inject, injectable, optional } from 'inversify';
import path from 'path';
import type { IDaemonConfigRepository } from '../repositories/daemon-config.repository';
import type { IDaemonStoreRepository } from '../repositories/daemon-store.repository';
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
import type { BlockerReport, IBlockerService } from './blocker.service';
import { ENGINE_RESUME_WAKE_ACTION_ID } from './engine-resume-wake.action';
import type { IStaleAgentService } from './stale-agent.service';

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
 * Per-workspace continuity tick (SPEC-PRD-0020-P2 T-01 / T-03).
 *
 * Scans DaemonConfig.runsDir for unfinished runs whose supervise.pid is dead,
 * and relaunches `--supervise` from launch.json under the run lock — except
 * abandoned idle runs (one wake, never relaunch) and needs-human blocker
 * outcomes (wake via the shared inbox; resume only through
 * EngineResumeWakeAction). Emits relaunch / abandoned / blocker evidence
 * through `commitWatchSignal` — never a chat session, deploy, or
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

/**
 * Issue-state shaped watch so blocker-cleared wakes share the GitHub watch
 * inbox path and carry `closed` for EngineResumeWakeAction.
 */
const blockerWatch = (
  runId: string,
  pollSeconds: number
): DurableWatchRecord => ({
  id: `issue-state:blockers:${runId}`,
  kind: 'issue-state',
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
    @inject(WORKFLOW_TOKENS.BlockerService)
    private readonly _blockers: IBlockerService,
    @inject(WORKFLOW_TOKENS.StaleAgentService)
    @optional()
    private readonly _staleAgent?: IStaleAgentService
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
    // T-02: per-run stale-agent kill shares this continuity tick.
    if (this._staleAgent !== undefined) {
      await this._staleAgent.tick(workspaceRoot);
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

    if (this.isFinished(state, runsDir, runId) === true) {
      return { runId, reason: 'finished' };
    }

    const launch = readSuperviseLaunchRecord(runsDir, runId);
    const blockerReport = this.queryBlockers(runsDir, runId, launch);
    if (blockerReport !== null && blockerReport.resumable === true) {
      this.emitBlockerClearedWake(
        workspaceRoot,
        runId,
        pollSeconds,
        blockerReport
      );
    }

    const pid = readSupervisePid(path.join(runsDir, runId));
    if (pid === null) {
      return { runId, reason: 'no-supervise-pid' };
    }
    if (this._detachRepo.isAlive(pid) === true) {
      return { runId, reason: 'alive' };
    }

    if (launch === null || launchUsable(launch) === false) {
      return { runId, reason: 'launch-unusable' };
    }

    if (
      blockerReport !== null &&
      blockerReport.blockers.some(blocker => blocker.state === 'open') === true
    ) {
      return { runId, reason: 'unresolved-blockers' };
    }

    // Resume after needs-human close is EngineResumeWakeAction's job — do not
    // become a second resume engine by also spawning here.
    if (blockerReport !== null && blockerReport.resumable === true) {
      return { runId, reason: 'blockers-cleared' };
    }

    const idle = this._runStateRepo.idleSeconds(runsDir, runId) ?? 0;
    if (idle > abandonedSeconds()) {
      this.emitAbandonedWake(workspaceRoot, runId, pollSeconds, idle);
      return { runId, reason: 'abandoned' };
    }

    return this.relaunch(workspaceRoot, runsDir, runId, launch, pollSeconds);
  }

  private queryBlockers(
    runsDir: string,
    runId: string,
    launch: SuperviseLaunchRecord | null
  ): BlockerReport | null {
    if (launch === null) {
      return null;
    }
    const repoPath = launch.repoPath.trim();
    if (repoPath.length === 0) {
      return null;
    }
    try {
      return this._blockers.query({ runsDir, runId, repoPath });
    } catch {
      return null;
    }
  }

  private emitAbandonedWake(
    workspaceRoot: string,
    runId: string,
    pollSeconds: number,
    idleSeconds: number
  ): void {
    const idleHours = Math.max(1, Math.floor(idleSeconds / 3_600));
    commitWatchSignal(
      this._store,
      workspaceRoot,
      continuityWatch(runId, pollSeconds),
      {
        id: `abandoned:${runId}`,
        observedAt: new Date().toISOString(),
        prompt: `SDLC run ${runId} is unfinished with a dead supervisor and has been idle for ${idleHours}h. The continuity daemon did not relaunch it. Decide whether to resume it or close it out.`,
        data: {
          runId,
          idleSeconds,
          signal: 'abandoned'
        }
      }
    );
  }

  private emitBlockerClearedWake(
    workspaceRoot: string,
    runId: string,
    pollSeconds: number,
    report: BlockerReport
  ): void {
    // `closed` is the EngineResumeWakeAction resume signal; continuity only
    // commits the wake — resume is owned by the registered wake action.
    commitWatchSignal(
      this._store,
      workspaceRoot,
      blockerWatch(runId, pollSeconds),
      {
        id: `closed:blockers-cleared:${runId}`,
        observedAt: new Date().toISOString(),
        prompt: `Every needs-human issue for SDLC run ${runId} has been closed. Resume proceeds through the registered ${ENGINE_RESUME_WAKE_ACTION_ID} wake action — continuity does not relaunch.`,
        data: {
          signal: 'closed',
          runId,
          blockersCleared: report.blockers.length,
          resumeAction: ENGINE_RESUME_WAKE_ACTION_ID
        }
      }
    );
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
