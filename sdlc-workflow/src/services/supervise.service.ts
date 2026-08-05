import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync
} from 'fs';
import { inject, injectable } from 'inversify';
import path from 'path';
import chalk from 'chalk';
import type { IGitRepository } from '../repositories/git.repository';
import type { IProcessDetachRepository } from '../repositories/process-detach.repository';
import type { IPullRequestRepository } from '../repositories/pull-request.repository';
import type {
  IRunQueueRepository,
  QueuedLaunchRecord
} from '../repositories/run-queue.repository';
import type {
  IRunLockRepository,
  RunLock
} from '../repositories/run-lock.repository';
import type { IRunStateRepository } from '../repositories/run-state.repository';
import type { ISpecDocRepository } from '../repositories/spec-doc.repository';
import type {
  ISuperviseExitRepository,
  SuperviseExitRecord
} from '../repositories/supervise-exit.repository';
import type { IWakeInboxRepository } from '../repositories/wake-inbox.repository';
import type { SpecDocument } from '../types';
import type {
  IRunHandler,
  RunTaskInput,
  RunTaskResult
} from '../handlers/run.handler';
import { WORKFLOW_TOKENS } from '../tokens';
import {
  allTasksMerged,
  hasMergeBlockedHalt,
  hasUnmergedCompletedTasks,
  phaseComplete
} from '../utils/run-completion';
import { closeoutBranch } from '../utils/spec-closeout';
import { buildSuperviseChildArgv } from '../utils/supervise-argv';
import {
  exitRecordFromError,
  exitRecordFromResult,
  formatExitMonitorLine,
  installSuperviseTerminalHandlers
} from '../utils/supervise-terminal';
import type { IHeartbeatWatchService } from './heartbeat-watch.service';

/**
 * How long to watch a detached child before claiming it started. Startup
 * failures throw within milliseconds of the child's *own* start, but the child
 * is `node`/`tsx` booting a TypeScript entry point, which on a loaded machine
 * can take seconds before it reaches the throw.
 *
 * @remarks
 * A single sample at 1.5s used to decide this, and under load it sampled while
 * the child was still booting — alive, so the parent printed "detached" and
 * exited 0 for a run that died a second later. The window is watched, not
 * sampled, and it ends the moment there is evidence either way, so a healthy
 * launch is not slowed by the larger budget.
 */
const DETACH_STARTUP_GRACE_MS = 8_000;
const DETACH_STARTUP_POLL_MS = 150;
const DETACH_FAILURE_LOG_LINES = 20;

/**
 * Wave 0: how many times a merge-blocked wave is retried before the run
 * stops for a human.
 *
 * @remarks
 * The performance postmortem measured 28 merge-blocked supervisor exits
 * across 79 waves, each ending the process and waiting for a hand
 * relaunch — together the bulk of 1,560 idle minutes (62.7% of elapsed
 * time). Most were mechanical: a CI verdict polled before checks
 * registered, or a `gh pr merge` that lost a race with a sibling landing on
 * the default branch. Both clear on a retry; neither needed a human.
 *
 * The budget is small and persisted (`state.mergeBlockedRetries`) so a
 * genuinely stuck run still reaches a human quickly, and a relaunch cannot
 * refill it into an infinite loop.
 */
const MERGE_BLOCKED_RETRY_LIMIT = 3;
const DEFAULT_MERGE_BLOCKED_BACKOFF_MS = 30_000;

/**
 * Steps dropped before a merge-blocked retry. Re-evaluating these is the
 * entire point of the retry: `ci` because absent checks are the dominant
 * false block, `phase` because it aggregates `ci`, and `merge` is never
 * cached on a blocked task anyway. `implementation`, `reviewer`, `sandbox`
 * and `verification` are deliberately kept — replaying paid agent work
 * that already reached a verdict is pure cost, and reviewer/envelope
 * findings are the remediation loop's job, not the retry's.
 */
const MERGE_BLOCKED_RETRY_STEPS = new Set(['ci', 'phase']);

const sleep = (ms: number): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, ms));

/** Last `count` non-empty lines of a log, for surfacing a child's own error. */
const tailFile = (filePath: string, count: number): string => {
  try {
    return readFileSync(filePath, 'utf-8')
      .split('\n')
      .filter(line => line.trim().length > 0)
      .slice(-count)
      .join('\n');
  } catch {
    return '';
  }
};

export interface SuperviseInput extends RunTaskInput {
  /**
   * Loop waves until all tasks merge (enforce) or a terminal gate/human
   * stop. Recommended operator default; may become CLI default later.
   */
  supervise: boolean;
  /**
   * Spawn a detached supervise child and return immediately (#38). Implies
   * supervise in the child. Parent prints PID + monitor paths then exits.
   */
  detach: boolean;
  /** Cap on wave iterations (default 20). */
  maxWaves?: number;
  /** Optional override for the live monitor log path. */
  monitorPath?: string;
  /**
   * Argv for the detached child (defaults to `process.argv`). Tests inject a
   * synthetic `run …` argv; production leaves this unset.
   */
  detachArgv?: string[];
  /**
   * Override wake-inbox root for tests (`…/wake`). Production leaves unset
   * so wakes land in `$ROSETTA_WAKE_DIR` / `~/.rosetta/wake`.
   */
  wakeDir?: string;
  /**
   * Base backoff before a merge-blocked retry wave, default 30s (doubled
   * per attempt). Tests pass 0.
   */
  mergeBlockedBackoffMs?: number;
  /**
   * How long to watch a detached child for a startup death before reporting
   * it as launched. Tests shorten it; production leaves it unset.
   */
  detachVerifyMs?: number;
}

export interface SuperviseResult {
  kind: 'detached' | 'completed' | 'stopped' | 'failed';
  waves: number;
  pid?: number;
  monitorPath?: string;
  logPath?: string;
  lastWave?: RunTaskResult;
  detail?: string;
}

/**
 * Operator supervise loop: auto-resume dependency waves after enforce merges,
 * mirror heartbeats into a live monitor log, and optionally detach so agent
 * shells cannot kill the run (Comita live-val / #38 / #39).
 */
export interface ISuperviseService {
  run(input: SuperviseInput): Promise<SuperviseResult>;
}

@injectable()
export class SuperviseService implements ISuperviseService {
  constructor(
    @inject(WORKFLOW_TOKENS.RunHandler)
    private readonly _runHandler: IRunHandler,
    @inject(WORKFLOW_TOKENS.SpecDocRepository)
    private readonly _specDocRepo: ISpecDocRepository,
    @inject(WORKFLOW_TOKENS.RunStateRepository)
    private readonly _runStateRepo: IRunStateRepository,
    @inject(WORKFLOW_TOKENS.ProcessDetachRepository)
    private readonly _detachRepo: IProcessDetachRepository,
    @inject(WORKFLOW_TOKENS.HeartbeatWatchService)
    private readonly _hbWatch: IHeartbeatWatchService,
    @inject(WORKFLOW_TOKENS.GitRepository)
    private readonly _gitRepo: IGitRepository,
    @inject(WORKFLOW_TOKENS.SuperviseExitRepository)
    private readonly _exitRepo: ISuperviseExitRepository,
    @inject(WORKFLOW_TOKENS.WakeInboxRepository)
    private readonly _wakeRepo: IWakeInboxRepository,
    @inject(WORKFLOW_TOKENS.RunQueueRepository)
    private readonly _runQueueRepo: IRunQueueRepository,
    @inject(WORKFLOW_TOKENS.RunLockRepository)
    private readonly _runLockRepo: IRunLockRepository,
    @inject(WORKFLOW_TOKENS.PullRequestRepository)
    private readonly _prRepo: IPullRequestRepository
  ) {}

  async run(input: SuperviseInput): Promise<SuperviseResult> {
    if (input.detach === true) {
      // The parent only spawns and reports; the child holds the lock for the
      // life of the run. Taking it here would make every detached launch race
      // its own child.
      return this.detach(input);
    }

    // SPEC-PRD-0021-P1 T-02. Held for the whole session, not per write: the
    // race this closes is a continuity-layer relaunch starting a second engine
    // over a live one, and two processes taking turns writing valid states
    // still interleave waves and double-dispatch agents.
    const lock = this.acquireSession(input);
    try {
      if (input.supervise !== true) {
        const lastWave = await this._runHandler.runTask(input);
        return {
          kind: this.mapWaveKind(lastWave, input),
          waves: 1,
          lastWave
        };
      }
      return await this.loop(input);
    } finally {
      if (lock !== undefined) this._runLockRepo.release(lock);
    }
  }

  /**
   * Take the run lock, or fail fast naming the live holder.
   *
   * @remarks
   * Returns `undefined` only when this process already holds the lock, which
   * happens when a resume re-enters through the same process — releasing a
   * lock we did not take here would hand the run to a waiting relaunch
   * mid-wave.
   */
  private acquireSession(input: SuperviseInput): RunLock | undefined {
    if (this._runLockRepo.heldByThisProcess(input.runsDir, input.runId)) {
      return undefined;
    }
    return this._runLockRepo.acquire(
      input.runsDir,
      input.runId,
      input.supervise === true ? 'supervise' : 'run'
    );
  }

  private async detach(input: SuperviseInput): Promise<SuperviseResult> {
    const runDir = path.join(input.runsDir, input.runId);
    mkdirSync(runDir, { recursive: true });
    const logPath = path.join(runDir, 'supervise.log');
    const monitorPath = input.monitorPath ?? path.join(runDir, 'monitor.log');
    const pidPath = path.join(runDir, 'supervise.pid');

    const childArgv = buildSuperviseChildArgv(input.detachArgv ?? process.argv);
    const { pid } = this._detachRepo.spawnDetached({
      command: process.execPath,
      // Replay the interpreter flags. Running from source, execPath is plain
      // node and the entry is a `.ts` file, so dropping them detaches into a
      // guaranteed ERR_UNKNOWN_FILE_EXTENSION before the first wave.
      args: [...process.execArgv, ...childArgv],
      cwd: process.cwd(),
      logPath,
      env: {
        ...process.env,
        SDLC_SUPERVISE_MONITOR: monitorPath
      }
    });

    writeFileSync(pidPath, `${pid}\n`);

    // A child that dies during startup — spec path wrong, spec unparseable,
    // spec still Draft, repo not a worktree — would otherwise leave the parent
    // printing a cheerful "detached" and exiting 0, so the operator walks away
    // from a run that never began. Confirm the child actually survived before
    // claiming success.
    if (!(await this.survivedStartup(pid, runDir, input.detachVerifyMs))) {
      const detail = tailFile(logPath, DETACH_FAILURE_LOG_LINES);
      console.error(
        chalk.red(`\n[supervise] detached child exited during startup`)
      );
      console.error(`  runId: ${input.runId}`);
      console.error(`  log:   ${logPath}`);
      if (detail.length > 0) console.error(`\n${detail}`);
      return { kind: 'failed', waves: 0, pid, monitorPath, logPath, detail };
    }

    this._hbWatch.note(
      monitorPath,
      `[supervise] detached pid=${pid} runId=${input.runId} log=${logPath}`
    );

    console.log(chalk.bold('\n[supervise] detached'));
    console.log(`  pid:     ${pid}`);
    console.log(`  runId:   ${input.runId}`);
    console.log(`  log:     ${logPath}`);
    console.log(`  monitor: ${monitorPath}`);
    console.log(`  pidfile: ${pidPath}`);
    console.log(
      chalk.gray('  Child runs with --supervise (wave auto-resume + hb watch).')
    );

    return {
      kind: 'detached',
      waves: 0,
      pid,
      monitorPath,
      logPath
    };
  }

  /**
   * Watch a freshly detached child until there is evidence it started, or
   * evidence it did not.
   *
   * @remarks
   * Two independent proofs of failure, because either alone has a blind spot:
   * the child's own `supervise.exit` record is deterministic but only exists
   * once it reached its terminal handler, and pid liveness catches a child that
   * died too hard to record anything. Returning `true` on deadline is the only
   * optimistic branch, and by then the child has had the whole window to fail.
   */
  private async survivedStartup(
    pid: number,
    runDir: string,
    verifyMs: number | undefined
  ): Promise<boolean> {
    const budgetMs = verifyMs ?? DETACH_STARTUP_GRACE_MS;
    const deadline = Date.now() + budgetMs;
    do {
      await sleep(Math.min(DETACH_STARTUP_POLL_MS, budgetMs));
      if (this._exitRepo.read(runDir) !== null) return false;
      if (!this._detachRepo.isAlive(pid)) return false;
    } while (Date.now() < deadline);
    return true;
  }

  private async loop(input: SuperviseInput): Promise<SuperviseResult> {
    const maxWaves = input.maxWaves ?? 20;
    const runDir = path.join(input.runsDir, input.runId);
    mkdirSync(runDir, { recursive: true });
    const monitorPath =
      input.monitorPath ??
      process.env.SDLC_SUPERVISE_MONITOR ??
      path.join(runDir, 'monitor.log');
    const heartbeatPath = path.join(runDir, 'heartbeat.jsonl');

    writeFileSync(path.join(runDir, 'supervise.pid'), `${process.pid}\n`);
    this._hbWatch.start({
      heartbeatPath,
      monitorPath,
      pollMs: 1000
    });

    // #38 / fail-loud T-02: any trappable termination writes supervise.exit,
    // a terminal monitor.log line, and a durable wake. Idempotent so signal
    // handlers and the intentional finish path cannot double-emit.
    let recorded = false;
    const recordTerminal = (record: SuperviseExitRecord): void => {
      if (recorded) {
        return;
      }
      recorded = true;
      this._exitRepo.write(runDir, record);
      this._hbWatch.note(monitorPath, formatExitMonitorLine(record));
      this._wakeRepo.emit({
        kind: 'sdlc_supervisor',
        dedupeKey: `${input.runId}-exit`,
        prompt: `SDLC supervise run ${input.runId} exited (code ${record.code}, reason ${record.reason}, abnormal=${record.abnormal}). Inspect ${runDir}/supervise.exit and ${monitorPath}.`,
        data: {
          runId: input.runId,
          code: record.code,
          reason: record.reason,
          abnormal: record.abnormal
        },
        wakeDir: input.wakeDir
      });
    };

    const handlers = installSuperviseTerminalHandlers(recordTerminal);

    let waves = 0;
    let lastWave: RunTaskResult | undefined;

    // Only an *intentional* terminal outcome clears our pid file. A crash —
    // thrown error, SIGKILL, OOM — must leave supervise.pid in place: a dead
    // pid behind a live file is exactly the continuity daemon's relaunch cue
    // (#37). Clearing in `finally` would erase that cue on every throw.
    const finish = (result: SuperviseResult): SuperviseResult => {
      recordTerminal(exitRecordFromResult(result));
      this.clearOwnSupervisePid(runDir);
      return result;
    };

    try {
      while (waves < maxWaves) {
        waves += 1;
        this._hbWatch.note(
          monitorPath,
          `[supervise] wave ${waves} start ${new Date().toISOString()}`
        );
        console.log(chalk.bold(`\n[supervise] wave ${waves}/${maxWaves}`));

        lastWave = await this._runHandler.runTask(input);

        const spec = this.readSpecForSupervise(input);
        const state = this._runStateRepo.load(input.runsDir, input.runId);

        if (this.phaseIsComplete(input, spec, state, monitorPath)) {
          this._hbWatch.note(
            monitorPath,
            `[supervise] ALL TASKS MERGED after wave ${waves}`
          );
          console.log(chalk.green('\n[supervise] all tasks merged — done'));
          // T-02: a completing *enforce* run is the interim consumer of the
          // durable launch queue — pop the head record when its spec has
          // landed as Approved; shadow calibration runs never merge for
          // real, so they must never advance someone else's queue.
          if (input.shadow !== true) {
            await this.consumeQueue(input, monitorPath);
          }
          return finish({
            kind: 'completed',
            waves,
            lastWave,
            monitorPath,
            detail: 'all-tasks-merged'
          });
        }

        const anyFailed = lastWave.tasks.some(t => t.kind === 'failed');
        if (lastWave.outcome === 'blocked' || anyFailed) {
          this._hbWatch.note(
            monitorPath,
            `[supervise] stopped wave ${waves}: ${lastWave.outcome} failed=${anyFailed}`
          );
          return finish({
            kind: 'failed',
            waves,
            lastWave,
            monitorPath,
            detail: anyFailed ? 'task-failed' : 'blocked'
          });
        }

        // Enforce: completed-but-unmerged after a red phase is a hard stop —
        // do not spin another "no ready task" wave (Comita Phase 0b lesson).
        if (
          input.shadow !== true &&
          hasMergeBlockedHalt(
            state,
            lastWave.tasks.map(task => task.taskId)
          )
        ) {
          const blockedTaskIds = lastWave.tasks.map(task => task.taskId);
          if (
            await this.retryMergeBlocked(input, monitorPath, blockedTaskIds)
          ) {
            continue;
          }
          this._hbWatch.note(
            monitorPath,
            `[supervise] MERGE BLOCKED after wave ${waves} — escalate / fix gates, then resume`
          );
          console.log(
            chalk.red(
              '\n[supervise] merge blocked — fix red gates or PR conflicts, then resume'
            )
          );
          return finish({
            kind: 'failed',
            waves,
            lastWave,
            monitorPath,
            detail: 'merge-blocked'
          });
        }

        // Shadow mode: merges are human — stop after the wave for review.
        if (input.shadow === true && hasUnmergedCompletedTasks(state)) {
          this._hbWatch.note(
            monitorPath,
            `[supervise] HUMAN GATE (shadow) after wave ${waves} — merge + record-merge, then resume`
          );
          console.log(
            chalk.bold(
              '\n[supervise] shadow human gate — merge task PRs, record-merge, re-run with --supervise'
            )
          );
          return finish({
            kind: 'stopped',
            waves,
            lastWave,
            monitorPath,
            detail: 'shadow-human-gate'
          });
        }

        if (lastWave.outcome === 'no-ready-task') {
          this._hbWatch.note(
            monitorPath,
            `[supervise] no ready task and not all merged after wave ${waves}`
          );
          return finish({
            kind: 'stopped',
            waves,
            lastWave,
            monitorPath,
            detail: 'no-ready-task'
          });
        }

        // Enforce wave merged something (or cached) — continue for dependents.
        appendFileSync(
          monitorPath,
          `[supervise] wave ${waves} complete — resuming for dependents\n`
        );
      }

      return finish({
        kind: 'failed',
        waves,
        lastWave,
        monitorPath,
        detail: `max-waves-${maxWaves}`
      });
    } catch (err) {
      // Thrown mid-loop: leave supervise.pid for the continuity daemon, but
      // never exit silently — write the terminal record + wake before rethrow.
      recordTerminal(exitRecordFromError(err));
      throw err;
    } finally {
      this._hbWatch.note(
        monitorPath,
        `[hb-watch] stopped ${new Date().toISOString()}`
      );
      this._hbWatch.stop();
      handlers.disarm();
    }
  }

  /**
   * Remove supervise.pid when — and only when — it records this process.
   *
   * Called exclusively from the loop's `finish()` on intentional terminal
   * outcomes (completed / blocked / merge-blocked / shadow gate /
   * no-ready-task / max-waves) so the continuity daemon does not relaunch a
   * finished invocation. Crashes never reach this: a thrown error, SIGKILL,
   * or OOM leaves the pid file behind, which is the daemon's relaunch cue.
   */
  private clearOwnSupervisePid(runDir: string): void {
    const pidPath = path.join(runDir, 'supervise.pid');
    try {
      if (!existsSync(pidPath)) return;
      const recorded = readFileSync(pidPath, 'utf-8').trim();
      if (recorded === String(process.pid)) {
        unlinkSync(pidPath);
      }
    } catch {
      // Best-effort — a stale pid is worse than a missing one only when the
      // daemon would relaunch a terminal refusal; ignore FS races.
    }
  }

  /**
   * Wave 0: consume one merge-blocked retry from the run's budget. Returns
   * true when the caller should run another wave, false when the block must
   * reach a human.
   *
   * @remarks
   * A retry that does not invalidate the step cache is pointless — the wave
   * would replay the same cached red verdicts. So this drops the `ci` and
   * `phase` steps of the blocked tasks (see
   * {@link MERGE_BLOCKED_RETRY_STEPS}) before backing off, which is what
   * lets a CI verdict recorded before GitHub registered any checks be
   * re-judged against the checks that have since appeared.
   *
   * The budget is deliberately not per-task: a wave stops on the first
   * blocked task, and per-task budgets would let a 5-task wave spend 15
   * retries walking the same failure.
   */
  private async retryMergeBlocked(
    input: SuperviseInput,
    monitorPath: string,
    blockedTaskIds: string[]
  ): Promise<boolean> {
    const state = this._runStateRepo.load(input.runsDir, input.runId);
    if (state === null) return false;

    const spent = state.mergeBlockedRetries ?? 0;
    if (spent >= MERGE_BLOCKED_RETRY_LIMIT) {
      this._hbWatch.note(
        monitorPath,
        `[supervise] merge-blocked retries exhausted (${spent}/${MERGE_BLOCKED_RETRY_LIMIT}) — handing to a human`
      );
      return false;
    }

    const attempt = this._runStateRepo.recordMergeBlockedRetry(
      input.runsDir,
      state
    );
    const blocked = new Set(blockedTaskIds);
    const dropped = this._runStateRepo.invalidateSteps(
      input.runsDir,
      state,
      step =>
        step.taskId !== undefined &&
        blocked.has(step.taskId) &&
        MERGE_BLOCKED_RETRY_STEPS.has(step.name)
    );

    const backoffMs =
      (input.mergeBlockedBackoffMs ?? DEFAULT_MERGE_BLOCKED_BACKOFF_MS) *
      2 ** (attempt - 1);
    this._hbWatch.note(
      monitorPath,
      `[supervise] merge blocked — retry ${attempt}/${MERGE_BLOCKED_RETRY_LIMIT} ` +
        `in ${Math.round(backoffMs / 1000)}s (re-evaluating ${dropped.length} ` +
        `cached step(s) for ${blockedTaskIds.join(', ')})`
    );
    console.log(
      chalk.yellow(
        `\n[supervise] merge blocked — retrying (${attempt}/${MERGE_BLOCKED_RETRY_LIMIT}) after ${Math.round(backoffMs / 1000)}s`
      )
    );
    if (backoffMs > 0) await sleep(backoffMs);
    return true;
  }

  private mapWaveKind(
    lastWave: RunTaskResult,
    input: SuperviseInput
  ): SuperviseResult['kind'] {
    if (lastWave.outcome === 'blocked') {
      return 'failed';
    }
    if (lastWave.tasks.some(t => t.kind === 'failed')) {
      return 'failed';
    }
    const spec = this.readSpecForSupervise(input);
    const state = this._runStateRepo.load(input.runsDir, input.runId);
    if (this.phaseIsComplete(input, spec, state)) {
      return 'completed';
    }
    return 'stopped';
  }

  /**
   * SPEC-PRD-0023-P1 T-04: "all tasks merged" is necessary but not
   * sufficient — the phase's closeout PR must also exist and be merged or
   * open awaiting Approve.
   *
   * @remarks
   * Queried live on every call, never cached: a closeout PR that someone
   * closes must stop counting. Shadow runs are exempt — they never merge for
   * real, so they never produce a closeout to wait for. A `gh` failure here
   * reports incomplete (fail closed) with a monitor line naming why, because
   * the alternative is claiming a phase is done on the strength of a network
   * error.
   */
  private phaseIsComplete(
    input: SuperviseInput,
    spec: SpecDocument,
    state: ReturnType<IRunStateRepository['load']>,
    monitorPath?: string
  ): boolean {
    if (!allTasksMerged(spec, state)) {
      return false;
    }
    if (input.shadow === true) {
      return true;
    }
    const branch = closeoutBranch(spec.id);
    let pr: { state: 'OPEN' | 'MERGED' | 'CLOSED' } | null = null;
    try {
      pr = this._prRepo.latestForBranch(input.repoPath, branch);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      this.noteIfWatched(
        monitorPath,
        `[supervise] cannot resolve closeout PR for ${spec.id} (${branch}) — ` +
          `phase reported incomplete: ${detail.slice(0, 200)}`
      );
      return false;
    }
    const complete = phaseComplete(spec, state, pr);
    if (!complete) {
      this.noteIfWatched(
        monitorPath,
        `[supervise] every task merged but the closeout PR for ${spec.id} is ` +
          `${pr === null ? 'missing' : pr.state.toLowerCase()} — phase incomplete (${branch})`
      );
    }
    return complete;
  }

  private noteIfWatched(monitorPath: string | undefined, line: string): void {
    if (monitorPath === undefined) return;
    this._hbWatch.note(monitorPath, line);
  }

  /**
   * Enforce: re-read the Approved blob from origin after each wave so
   * completion checks see post-merge checkbox / content updates.
   * Shadow: local working-tree file.
   */
  private readSpecForSupervise(input: SuperviseInput): SpecDocument {
    if (input.shadow === true) {
      return this._specDocRepo.read(input.specPath);
    }
    const relPath = path.relative(input.repoPath, input.specPath);
    if (relPath.startsWith('..') || path.isAbsolute(relPath)) {
      return this._specDocRepo.read(input.specPath);
    }
    this._gitRepo.fetch(input.repoPath);
    const ref = `origin/${this._gitRepo.defaultBranch(input.repoPath)}`;
    return (
      this._specDocRepo.readAtRef(input.repoPath, ref, relPath) ??
      this._specDocRepo.read(input.specPath)
    );
  }

  /**
   * T-02: pop the head of the durable launch queue when its spec is
   * Approved on `origin/<default>`; leave it queued (with a visible
   * monitor line) otherwise. A failed launch is never a silent drop — it
   * stays queued for retry and surfaces as a wake escalation.
   */
  private async consumeQueue(
    input: SuperviseInput,
    monitorPath: string
  ): Promise<void> {
    const head = this._runQueueRepo.peek(input.runsDir);
    if (head === null) {
      return;
    }
    const { seq, record } = head;

    if (!this.isQueuedSpecApproved(record)) {
      this._hbWatch.note(
        monitorPath,
        `[queue] head record not yet Approved — staying queued: ${record.specPath}`
      );
      return;
    }

    this._hbWatch.note(
      monitorPath,
      `[queue] launching queued run for ${record.specPath}`
    );

    try {
      const launch = await this.launchQueuedRecord(
        record,
        input.detachVerifyMs
      );
      if (launch.alive) {
        this._runQueueRepo.remove(input.runsDir, seq);
        this._hbWatch.note(
          monitorPath,
          `[queue] launched pid=${launch.pid} runId=${launch.runId} — dequeued ${record.specPath}`
        );
        return;
      }
      this.escalateQueueLaunchFailure(
        input,
        record,
        monitorPath,
        launch.detail.length > 0
          ? launch.detail
          : 'detached child exited during startup'
      );
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      this.escalateQueueLaunchFailure(input, record, monitorPath, detail);
    }
  }

  /**
   * Approved on `origin/<default>` (or the working-tree file when the
   * queued spec lives outside the queued repo checkout). Any read failure
   * fails closed — leave queued; an unreadable spec is not a launch signal.
   */
  private isQueuedSpecApproved(record: QueuedLaunchRecord): boolean {
    try {
      const relPath = path.relative(record.repoPath, record.specPath);
      if (relPath.startsWith('..') || path.isAbsolute(relPath)) {
        return this._specDocRepo.read(record.specPath).status === 'Approved';
      }
      this._gitRepo.fetch(record.repoPath);
      const ref = `origin/${this._gitRepo.defaultBranch(record.repoPath)}`;
      const spec = this._specDocRepo.readAtRef(record.repoPath, ref, relPath);
      return spec?.status === 'Approved';
    } catch {
      return false;
    }
  }

  /**
   * Launch a queued record detached — the same mechanics `detach()` uses
   * for an operator-triggered detach: replay the record's `run` argv
   * through `buildSuperviseChildArgv`, spawn via the process-detach
   * repository, and confirm the child survives the startup grace window.
   */
  private async launchQueuedRecord(
    record: QueuedLaunchRecord,
    verifyMs: number | undefined
  ): Promise<{ pid: number; alive: boolean; runId: string; detail: string }> {
    const runId = record.runId ?? this.deriveQueuedRunId(record.specPath);
    const runDir = path.join(record.runsDir, runId);
    mkdirSync(runDir, { recursive: true });
    const logPath = path.join(runDir, 'supervise.log');
    const monitorPath = path.join(runDir, 'monitor.log');

    const childArgv = buildSuperviseChildArgv(record.argv);
    // Replay the record's captured interpreter, not this (enforcing)
    // process's own — the record is the contract precisely so a relaunch
    // long after enqueue, or from a differently-invoked daemon, still runs
    // under the Node binary/flags the operator actually queued (T-02
    // reviewer finding: using process.execPath/execArgv here silently
    // discarded the persisted fields).
    const { pid } = this._detachRepo.spawnDetached({
      command: record.execPath,
      args: [...record.execArgv, ...childArgv],
      cwd: record.cwd,
      logPath,
      env: {
        ...process.env,
        SDLC_SUPERVISE_MONITOR: monitorPath
      }
    });
    writeFileSync(path.join(runDir, 'supervise.pid'), `${pid}\n`);

    const alive = await this.survivedStartup(pid, runDir, verifyMs);
    return {
      pid,
      alive,
      runId,
      detail: alive ? '' : tailFile(logPath, DETACH_FAILURE_LOG_LINES)
    };
  }

  private deriveQueuedRunId(specPath: string): string {
    return `${path
      .basename(specPath)
      .replace(/\.md$/, '')}-${new Date().toISOString().slice(0, 10)}`;
  }

  /**
   * Fail-loud T-02 for the queue: a failed launch is never a silent drop.
   * The caller leaves the record queued for retry; this only surfaces a
   * durable wake so the operator sees it instead of it vanishing.
   */
  private escalateQueueLaunchFailure(
    input: SuperviseInput,
    record: QueuedLaunchRecord,
    monitorPath: string,
    detail: string
  ): void {
    this._hbWatch.note(
      monitorPath,
      `[queue] FAILED to launch queued run for ${record.specPath}: ${detail.slice(0, 300)} — retained for retry`
    );
    this._wakeRepo.emit({
      kind: 'sdlc_queue_launch',
      dedupeKey: `queue-launch-${record.specPath}`,
      prompt: `SDLC queue-run launch failed for ${record.specPath}: ${detail.slice(0, 500)}. The record is retained in the queue for retry — investigate, then relaunch by hand (run --spec ${record.specPath} --repo ${record.repoPath} --supervise --detach) if needed.`,
      data: {
        specPath: record.specPath,
        repoPath: record.repoPath,
        detail: detail.slice(0, 500)
      },
      wakeDir: input.wakeDir
    });
  }
}
