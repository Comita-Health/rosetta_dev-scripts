import { existsSync, mkdirSync, readFileSync, statSync } from 'fs';
import { inject, injectable } from 'inversify';
import path from 'path';
import { WORKFLOW_TOKENS } from '../tokens';
import {
  CriterionVerdict,
  EscalateTier,
  ExceptionEntry,
  GateVerdict,
  OperatorUnstickOutcome,
  RunState,
  SandboxRecord,
  StepResult,
  TaskRunResult,
  WorkflowError
} from '../types';
import { writeFileAtomic } from '../utils/atomic-write';
import type { IRunLockRepository } from './run-lock.repository';

/**
 * Persists run state as JSON under `<runsDir>/<runId>/state.json` so a
 * killed run can resume (SPEC-PRD-0011-P2 T-01; the full cached step graph
 * is T-09).
 */
export interface IRunStateRepository {
  load(runsDir: string, runId: string): RunState | null;
  /**
   * Seconds since `state.json` mtime (SPEC-PRD-0020-P2 T-03 abandoned idle).
   * `null` when the file is missing or unreadable.
   */
  idleSeconds(runsDir: string, runId: string): number | null;
  save(runsDir: string, state: RunState): string;
  appendVerdict(runsDir: string, state: RunState, verdict: GateVerdict): void;
  recordTaskResult(
    runsDir: string,
    state: RunState,
    result: TaskRunResult
  ): void;
  recordExceptions(
    runsDir: string,
    state: RunState,
    entries: ExceptionEntry[]
  ): void;
  recordSandbox(runsDir: string, state: RunState, record: SandboxRecord): void;
  recordCriteria(
    runsDir: string,
    state: RunState,
    verdicts: CriterionVerdict[]
  ): void;
  /** T-09: record a completed step under its cache key and persist. */
  recordStep(
    runsDir: string,
    state: RunState,
    key: string,
    step: StepResult
  ): void;
  /** T-08: record the human-approved merged SHA and persist. */
  recordMergedSha(runsDir: string, state: RunState, sha: string): void;
  /** P3 T-01: record a task's merge, unblocking its dependents. */
  recordTaskMerged(
    runsDir: string,
    state: RunState,
    taskId: string,
    sha: string
  ): void;
  /** P3 T-02: record the task's PR URL on its result. */
  recordTaskPrUrl(
    runsDir: string,
    state: RunState,
    taskId: string,
    prUrl: string
  ): void;
  /**
   * P3 T-03: increment the task's CI fix-attempt counter and persist.
   * Returns the new count. Persisted so resume never resets the budget.
   */
  recordCiFixAttempt(runsDir: string, state: RunState, taskId: string): number;
  /**
   * P3 T-06: add `deltaK` (thousands of tokens) to the run's cumulative
   * spend and persist. Returns the new total.
   */
  recordTokenSpend(runsDir: string, state: RunState, deltaK: number): number;
  /**
   * Wave 0: increment the task's gate remediation counter and persist.
   * Returns the new count. Persisted so resume never refills the budget.
   */
  recordGateFixAttempt(
    runsDir: string,
    state: RunState,
    taskId: string
  ): number;
  /**
   * SPEC-PRD-0025-P1 T-01: increment the task's operator-unstick counter
   * and persist. Returns the new count. Persisted so resume never refills
   * the unstick budget.
   */
  recordOperatorUnstickAttempt(
    runsDir: string,
    state: RunState,
    taskId: string
  ): number;
  /**
   * SPEC-PRD-0025-P1 T-01: record the latest operator-unstick outcome for
   * a task and persist.
   */
  recordOperatorUnstickOutcome(
    runsDir: string,
    state: RunState,
    taskId: string,
    outcome: OperatorUnstickOutcome,
    detail?: string
  ): void;
  /**
   * SPEC-PRD-0025-P1 T-01: set the task's escalate tier for status
   * surfaces and persist.
   */
  recordEscalateTier(
    runsDir: string,
    state: RunState,
    taskId: string,
    tier: EscalateTier
  ): void;
  /**
   * Wave 0: record the head SHA a remediation round produced. Task
   * re-selection consults this to reopen a task whose phase gate breached
   * before the fix landed.
   */
  recordRemediation(
    runsDir: string,
    state: RunState,
    taskId: string,
    sha: string,
    gates: string[]
  ): void;
  /**
   * Wave 0: increment and persist the run's supervisor merge-blocked retry
   * count. Returns the new count.
   */
  recordMergeBlockedRetry(runsDir: string, state: RunState): number;
  /**
   * Wave 0: drop cached steps matching `predicate` so the next wave
   * re-evaluates them, and persist. Returns the keys removed.
   *
   * @remarks
   * The supervisor's bounded merge-blocked retry needs this: replaying a
   * wave against an intact step cache reuses the same red verdicts and
   * makes no progress, so a retry that does not invalidate is just a
   * slower way to reach the same stop.
   */
  invalidateSteps(
    runsDir: string,
    state: RunState,
    predicate: (step: StepResult, key: string) => boolean
  ): string[];
}

const stateFile = (runsDir: string, runId: string): string =>
  path.join(runsDir, runId, 'state.json');

@injectable()
export class RunStateRepository implements IRunStateRepository {
  constructor(
    @inject(WORKFLOW_TOKENS.RunLockRepository)
    private readonly _lockRepo: IRunLockRepository
  ) {}

  load(runsDir: string, runId: string): RunState | null {
    const file = stateFile(runsDir, runId);
    if (!existsSync(file)) return null;
    const state = JSON.parse(readFileSync(file, 'utf-8')) as RunState;
    // Fill fields introduced after older state files were written.
    state.exceptions = state.exceptions ?? [];
    state.criterionVerdicts = state.criterionVerdicts ?? [];
    state.steps = state.steps ?? {};
    state.tokenSpendK = state.tokenSpendK ?? 0;
    state.ciFixAttempts = state.ciFixAttempts ?? {};
    state.gateFixAttempts = state.gateFixAttempts ?? {};
    state.operatorUnstickAttempts = state.operatorUnstickAttempts ?? {};
    state.operatorUnstickOutcomes = state.operatorUnstickOutcomes ?? {};
    state.escalateTiers = state.escalateTiers ?? {};
    state.remediations = state.remediations ?? {};
    state.mergeBlockedRetries = state.mergeBlockedRetries ?? 0;
    // #37 launch record — older states only had updatedAt.
    state.startedAt = state.startedAt ?? state.updatedAt;
    state.specDigest = state.specDigest ?? '';
    state.launchArgv = state.launchArgv ?? [];
    return state;
  }

  idleSeconds(runsDir: string, runId: string): number | null {
    const file = stateFile(runsDir, runId);
    try {
      if (existsSync(file) === false) {
        return null;
      }
      const ageMs = Date.now() - statSync(file).mtimeMs;
      return Math.max(0, Math.floor(ageMs / 1_000));
    } catch {
      return null;
    }
  }

  /**
   * T-01 / T-02: every write is atomic (temp file + `fsync` + `rename`) and
   * happens under the run lock, so a crash cannot tear the file and a second
   * writer cannot interleave with the first.
   *
   * @remarks
   * Callers that own a run for its whole lifetime (`run`, `supervise`) hold
   * the lock across the session. Short-lived mutators that did not acquire
   * one still write under a *momentary* lock taken here, so there is no path
   * to an unlocked write — the difference is only how long the lock is held.
   *
   * @throws `WorkflowError` `RUN_LOCK_NOT_HELD` when another live process
   * owns the run. That is a refusal to clobber, not a transient failure:
   * retrying it without stopping the other writer will fail the same way.
   */
  save(runsDir: string, state: RunState): string {
    const file = stateFile(runsDir, state.runId);
    mkdirSync(path.dirname(file), { recursive: true });
    state.updatedAt = new Date().toISOString();
    const contents = `${JSON.stringify(state, null, 2)}\n`;

    if (this._lockRepo.heldByThisProcess(runsDir, state.runId)) {
      writeFileAtomic(file, contents);
      return file;
    }

    let lock;
    try {
      lock = this._lockRepo.acquire(runsDir, state.runId, 'state-write');
    } catch (err) {
      const holder = this._lockRepo.holder(runsDir, state.runId);
      throw new WorkflowError(
        `refusing to write state.json for run ${state.runId}: the run lock is held by another writer`,
        'RUN_LOCK_NOT_HELD',
        [
          holder === null
            ? 'lock holder could not be identified'
            : `held by pid ${holder.pid} on ${holder.host} (${holder.owner}) since ${holder.acquiredAt}`,
          // The acquisition's own details, not just its summary: when no
          // holder can be named, they carry the only concrete thing left —
          // the lock path an operator has to go look at.
          ...(err instanceof WorkflowError
            ? err.details
            : [err instanceof Error ? err.message : String(err)])
        ]
      );
    }
    try {
      writeFileAtomic(file, contents);
    } finally {
      this._lockRepo.release(lock);
    }
    return file;
  }

  appendVerdict(runsDir: string, state: RunState, verdict: GateVerdict): void {
    state.verdicts.push(verdict);
    this.save(runsDir, state);
  }

  recordTaskResult(
    runsDir: string,
    state: RunState,
    result: TaskRunResult
  ): void {
    // Preserve merge / PR metadata across re-records so a tip-driven
    // digest reopen cannot wipe `mergedSha` (live-val shadow-2).
    const prior = state.taskResults[result.taskId];
    state.taskResults[result.taskId] = {
      ...result,
      mergedSha: result.mergedSha ?? prior?.mergedSha,
      prUrl: result.prUrl ?? prior?.prUrl
    };
    this.save(runsDir, state);
  }

  recordExceptions(
    runsDir: string,
    state: RunState,
    entries: ExceptionEntry[]
  ): void {
    if (entries.length === 0) return;
    state.exceptions.push(...entries);
    this.save(runsDir, state);
  }

  recordSandbox(runsDir: string, state: RunState, record: SandboxRecord): void {
    state.sandbox = record;
    this.save(runsDir, state);
  }

  recordCriteria(
    runsDir: string,
    state: RunState,
    verdicts: CriterionVerdict[]
  ): void {
    if (verdicts.length === 0) return;
    state.criterionVerdicts.push(...verdicts);
    this.save(runsDir, state);
  }

  recordStep(
    runsDir: string,
    state: RunState,
    key: string,
    step: StepResult
  ): void {
    state.steps[key] = step;
    this.save(runsDir, state);
  }

  recordMergedSha(runsDir: string, state: RunState, sha: string): void {
    state.mergedSha = sha;
    this.save(runsDir, state);
  }

  recordTaskMerged(
    runsDir: string,
    state: RunState,
    taskId: string,
    sha: string
  ): void {
    const result = state.taskResults[taskId];
    if (result === undefined) return;
    result.mergedSha = sha;
    // A landed merge unsticks the supervise merge-blocked budget. Without
    // this, an operator `record-merge` (or out-of-band reconcile) after
    // MERGE_BLOCKED_RETRY_LIMIT leaves resume immediately "retries
    // exhausted" even though the blocker is gone (#79).
    state.mergeBlockedRetries = 0;
    this.save(runsDir, state);
  }

  recordTaskPrUrl(
    runsDir: string,
    state: RunState,
    taskId: string,
    prUrl: string
  ): void {
    const result = state.taskResults[taskId];
    if (result === undefined) return;
    result.prUrl = prUrl;
    this.save(runsDir, state);
  }

  recordCiFixAttempt(runsDir: string, state: RunState, taskId: string): number {
    const next = (state.ciFixAttempts[taskId] ?? 0) + 1;
    state.ciFixAttempts[taskId] = next;
    this.save(runsDir, state);
    return next;
  }

  recordTokenSpend(runsDir: string, state: RunState, deltaK: number): number {
    state.tokenSpendK = (state.tokenSpendK ?? 0) + deltaK;
    this.save(runsDir, state);
    return state.tokenSpendK;
  }

  recordGateFixAttempt(
    runsDir: string,
    state: RunState,
    taskId: string
  ): number {
    state.gateFixAttempts = state.gateFixAttempts ?? {};
    const next = (state.gateFixAttempts[taskId] ?? 0) + 1;
    state.gateFixAttempts[taskId] = next;
    this.save(runsDir, state);
    return next;
  }

  recordOperatorUnstickAttempt(
    runsDir: string,
    state: RunState,
    taskId: string
  ): number {
    state.operatorUnstickAttempts = state.operatorUnstickAttempts ?? {};
    const next = (state.operatorUnstickAttempts[taskId] ?? 0) + 1;
    state.operatorUnstickAttempts[taskId] = next;
    this.save(runsDir, state);
    return next;
  }

  recordOperatorUnstickOutcome(
    runsDir: string,
    state: RunState,
    taskId: string,
    outcome: OperatorUnstickOutcome,
    detail?: string
  ): void {
    state.operatorUnstickOutcomes = state.operatorUnstickOutcomes ?? {};
    state.operatorUnstickAttempts = state.operatorUnstickAttempts ?? {};
    state.operatorUnstickOutcomes[taskId] = {
      outcome,
      attempt: state.operatorUnstickAttempts[taskId] ?? 0,
      recordedAt: new Date().toISOString(),
      ...(detail !== undefined ? { detail } : {})
    };
    this.save(runsDir, state);
  }

  recordEscalateTier(
    runsDir: string,
    state: RunState,
    taskId: string,
    tier: EscalateTier
  ): void {
    state.escalateTiers = state.escalateTiers ?? {};
    state.escalateTiers[taskId] = tier;
    this.save(runsDir, state);
  }

  recordRemediation(
    runsDir: string,
    state: RunState,
    taskId: string,
    sha: string,
    gates: string[]
  ): void {
    state.remediations = state.remediations ?? {};
    state.remediations[taskId] = {
      attempt: state.gateFixAttempts?.[taskId] ?? 1,
      sha,
      gates,
      recordedAt: new Date().toISOString()
    };
    this.save(runsDir, state);
  }

  recordMergeBlockedRetry(runsDir: string, state: RunState): number {
    state.mergeBlockedRetries = (state.mergeBlockedRetries ?? 0) + 1;
    this.save(runsDir, state);
    return state.mergeBlockedRetries;
  }

  invalidateSteps(
    runsDir: string,
    state: RunState,
    predicate: (step: StepResult, key: string) => boolean
  ): string[] {
    const removed = Object.entries(state.steps)
      .filter(([key, step]) => predicate(step, key))
      .map(([key]) => key);
    if (removed.length === 0) return [];
    for (const key of removed) {
      delete state.steps[key];
    }
    this.save(runsDir, state);
    return removed;
  }
}
