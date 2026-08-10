import { execFileSync } from 'child_process';
import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readSync,
  readdirSync
} from 'fs';
import { inject, injectable } from 'inversify';
import path from 'path';
import type { IDaemonConfigRepository } from '../repositories/daemon-config.repository';
import type { IDaemonStoreRepository } from '../repositories/daemon-store.repository';
import type { IRunStateRepository } from '../repositories/run-state.repository';
import type { ISpecDocRepository } from '../repositories/spec-doc.repository';
import { WORKFLOW_TOKENS } from '../tokens';
import type { DurableWatchRecord, RunState, SpecDocument } from '../types';
import { readSuperviseLaunchRecord } from '../utils/launch-record';
import { appendMonitorLine } from '../utils/monitor';
import { allTasksMerged } from '../utils/run-completion';
import { commitWatchSignal } from '../utils/watch-wake-commit';

/**
 * Default wall-clock silence before an in-flight implementation agent is
 * treated as hung (matches the bash continuity daemon). Override with
 * `SDLC_AGENT_STALL_SECONDS` — never a hardcoded consumer path.
 */
export const DEFAULT_AGENT_STALL_SECONDS = 2_400;

/** Bytes of heartbeat.jsonl tail inspected for the latest snapshot. */
const HEARTBEAT_TAIL_BYTES = 8_192;

export interface StaleAgentSkip {
  runId: string;
  reason: string;
}

export interface StaleAgentTickResult {
  scanned: number;
  killed: string[];
  skipped: StaleAgentSkip[];
}

/**
 * Kill attempt scoped to one runId. Production default signals only agent
 * processes whose command line contains both the agent binary and the runId
 * (never a machine-global kill of unrelated agents).
 */
export type KillRunAgents = (input: { runId: string; runsDir: string }) => void;

export interface IStaleAgentService {
  /** One scan of runsDir; safe to call from ContinuityService / tests. */
  tick(workspaceRoot: string): Promise<StaleAgentTickResult>;
}

interface HeartbeatSnapshot {
  ts?: unknown;
  step?: unknown;
  agentAlive?: unknown;
  runId?: unknown;
}

const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const agentBinary = (): string => {
  const raw = process.env.CURSOR_AGENT_BIN;
  if (typeof raw === 'string' && raw.trim().length > 0) {
    return raw.trim();
  }
  return 'cursor-agent';
};

/**
 * Signal every process whose cmdline matches `<agentBin>.*<runId>`.
 * Scoped by run identity — not a bare `pkill cursor-agent`.
 */
export const killAgentsForRun: KillRunAgents = ({ runId }): void => {
  const pattern = `${escapeRegExp(agentBinary())}.*${escapeRegExp(runId)}`;
  try {
    execFileSync('pkill', ['-f', pattern], { stdio: 'ignore' });
  } catch {
    // pkill exits non-zero when nothing matched; that is still one attempt.
  }
};

const stallSeconds = (): number => {
  const raw = process.env.SDLC_AGENT_STALL_SECONDS;
  if (raw === undefined || raw.trim().length === 0) {
    return DEFAULT_AGENT_STALL_SECONDS;
  }
  const parsed = Number.parseInt(raw, 10);
  if (Number.isSafeInteger(parsed) === false || parsed <= 0) {
    return DEFAULT_AGENT_STALL_SECONDS;
  }
  return parsed;
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

interface HeartbeatInspection {
  last: HeartbeatSnapshot;
  ageSeconds: number;
  mtimeMs: number;
}

const inspectHeartbeat = (
  heartbeatPath: string
): HeartbeatInspection | null => {
  try {
    const fd = openSync(heartbeatPath, 'r');
    try {
      const st = fstatSync(fd);
      const size = st.size;
      if (size <= 0) {
        return null;
      }
      const start = Math.max(0, size - HEARTBEAT_TAIL_BYTES);
      const length = size - start;
      const buf = Buffer.alloc(length);
      readSync(fd, buf, 0, length, start);
      const lines = buf
        .toString('utf-8')
        .split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0);
      if (lines.length === 0) {
        return null;
      }
      const last = JSON.parse(
        lines[lines.length - 1] as string
      ) as HeartbeatSnapshot;
      const mtimeMs = st.mtimeMs;
      return {
        last,
        mtimeMs,
        ageSeconds: Math.max(0, Math.floor((Date.now() - mtimeMs) / 1_000))
      };
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
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
 * Per-run stale-agent kill (SPEC-PRD-0020-P2 T-02).
 *
 * Reads `heartbeat.jsonl` from engine artifacts. An in-flight implementation
 * heartbeat quieter than the stall threshold triggers exactly one kill attempt
 * scoped to that runId and one `agent-stalled` wake on the shared inbox.
 * Episode-keyed wake ids re-arm when the heartbeat recovers so a later stall
 * can notify again. Finished / unusable-state runs are skipped — matching
 * bash `check_hung_agent` (gated by `state.json` + `run_is_finished`) and
 * ContinuityService's `isFinished` / `allTasksMerged` checks.
 */
@injectable()
export class StaleAgentService implements IStaleAgentService {
  /**
   * Test seam: replace to assert kill scoping without signalling host
   * processes. Production default is {@link killAgentsForRun}.
   */
  killForRun: KillRunAgents = killAgentsForRun;

  constructor(
    @inject(WORKFLOW_TOKENS.DaemonConfigRepository)
    private readonly _configRepo: IDaemonConfigRepository,
    @inject(WORKFLOW_TOKENS.DaemonStoreRepository)
    private readonly _store: IDaemonStoreRepository,
    @inject(WORKFLOW_TOKENS.RunStateRepository)
    private readonly _runStateRepo: IRunStateRepository,
    @inject(WORKFLOW_TOKENS.SpecDocRepository)
    private readonly _specDocRepo: ISpecDocRepository
  ) {}

  async tick(workspaceRoot: string): Promise<StaleAgentTickResult> {
    const { config } = this._configRepo.load(workspaceRoot);
    const runsDir = config.runsDir;
    const result: StaleAgentTickResult = {
      scanned: 0,
      killed: [],
      skipped: []
    };
    const threshold = stallSeconds();
    for (const runId of listRunIds(runsDir)) {
      result.scanned += 1;
      const outcome = this.considerRun(
        workspaceRoot,
        runsDir,
        runId,
        config.defaultPollSeconds,
        threshold
      );
      if (outcome === null) {
        result.killed.push(runId);
      } else if (
        outcome.reason !== 'healthy' &&
        outcome.reason !== 'no-heartbeat'
      ) {
        result.skipped.push(outcome);
      }
    }
    return result;
  }

  /**
   * @returns null when a kill+wake was performed; otherwise a skip reason.
   */
  private considerRun(
    workspaceRoot: string,
    runsDir: string,
    runId: string,
    pollSeconds: number,
    threshold: number
  ): StaleAgentSkip | null {
    // Bash continuity only calls check_hung_agent when state.json is present
    // and the run is unfinished. Mirror ContinuityService here so a completed
    // run whose last heartbeat still looks "in-flight" never gets a kill/wake.
    const state = this._runStateRepo.load(runsDir, runId);
    if (state === null) {
      return { runId, reason: 'no-state' };
    }
    if (this.isFinished(state, runsDir, runId)) {
      return { runId, reason: 'finished' };
    }

    const runDir = path.join(runsDir, runId);
    const heartbeatPath = path.join(runDir, 'heartbeat.jsonl');
    if (existsSync(heartbeatPath) === false) {
      return { runId, reason: 'no-heartbeat' };
    }

    const inspected = inspectHeartbeat(heartbeatPath);
    if (inspected === null) {
      return { runId, reason: 'heartbeat-unreadable' };
    }

    const { last, ageSeconds, mtimeMs } = inspected;

    // Only an in-flight implementation step can be "hung"; idle / other steps
    // are fine (matches bash continuity check_hung_agent).
    if (last.step !== 'implementation' || last.agentAlive !== true) {
      return { runId, reason: 'healthy' };
    }

    if (ageSeconds <= threshold) {
      return { runId, reason: 'healthy' };
    }

    const episode =
      typeof last.ts === 'string' && last.ts.trim().length > 0
        ? last.ts.trim()
        : `mtime:${mtimeMs}`;

    // Commit the wake first — writeWake is idempotent per signal id, so a
    // repeated tick for the same episode returns created:false and we skip
    // the kill. A recovered heartbeat writes a new `ts`, which re-arms.
    const written = commitWatchSignal(
      this._store,
      workspaceRoot,
      continuityWatch(runId, pollSeconds),
      {
        id: `agent-stalled:${runId}:${episode}`,
        observedAt: new Date().toISOString(),
        prompt: `The implementation agent for SDLC run ${runId} was stalled for ${ageSeconds}s and the daemon killed it. Review the task transcript for a loop, then resume the run.`,
        data: {
          runId,
          stalledSeconds: ageSeconds,
          signal: 'agent-stalled'
        }
      }
    );

    if (written.created === false) {
      return { runId, reason: 'already-notified' };
    }

    this.killForRun({ runId, runsDir });
    appendMonitorLine(
      path.join(runDir, 'monitor.log'),
      `[continuity] implementation agent stalled ${ageSeconds}s — killing`
    );
    return null;
  }

  private isFinished(state: RunState, runsDir: string, runId: string): boolean {
    const launch = readSuperviseLaunchRecord(runsDir, runId);
    const spec = this.loadSpec(state, launch?.specPath ?? null);
    if (spec === null) {
      return false;
    }
    return allTasksMerged(spec, state);
  }

  private loadSpec(
    state: RunState,
    launchSpecPath: string | null
  ): SpecDocument | null {
    const candidates = [launchSpecPath, state.specPath].filter(
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
}
