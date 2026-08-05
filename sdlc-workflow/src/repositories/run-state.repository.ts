import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { injectable } from 'inversify';
import path from 'path';
import {
  CriterionVerdict,
  ExceptionEntry,
  GateVerdict,
  RunState,
  SandboxRecord,
  StepResult,
  TaskRunResult
} from '../types';

/**
 * Persists run state as JSON under `<runsDir>/<runId>/state.json` so a
 * killed run can resume (SPEC-PRD-0011-P2 T-01; the full cached step graph
 * is T-09).
 */
export interface IRunStateRepository {
  load(runsDir: string, runId: string): RunState | null;
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
    state.remediations = state.remediations ?? {};
    state.mergeBlockedRetries = state.mergeBlockedRetries ?? 0;
    // #37 launch record — older states only had updatedAt.
    state.startedAt = state.startedAt ?? state.updatedAt;
    state.specDigest = state.specDigest ?? '';
    state.launchArgv = state.launchArgv ?? [];
    return state;
  }

  save(runsDir: string, state: RunState): string {
    const file = stateFile(runsDir, state.runId);
    mkdirSync(path.dirname(file), { recursive: true });
    state.updatedAt = new Date().toISOString();
    writeFileSync(file, JSON.stringify(state, null, 2));
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
