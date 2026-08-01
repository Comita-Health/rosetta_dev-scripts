import { inject, injectable } from 'inversify';
import path from 'path';
import type { IAgentRunnerRepository } from '../repositories/agent-runner.repository';
import type { IGitRepository } from '../repositories/git.repository';
import type { IRunStateRepository } from '../repositories/run-state.repository';
import type { ISpecDocRepository } from '../repositories/spec-doc.repository';
import { WORKFLOW_TOKENS } from '../tokens';
import { RunState, SpecDocument, SpecTask, stepKey } from '../types';
import { inputsDigest } from '../utils/digest';
import { buildImplementationPrompt } from '../utils/implementation-prompt';

export interface ExecutorInput {
  specPath: string;
  repoPath: string;
  runId: string;
  runsDir: string;
}

export interface PoolInput extends ExecutorInput {
  /** Upper bound on concurrently running implementation agents. */
  maxParallel: number;
}

/** Per-task outcome of one pool wave. */
export interface ExecutorOutcome {
  kind: 'completed' | 'failed';
  task: SpecTask;
  branch: string;
  detail?: string;
  /** True when the implementation step was reused from the T-09 cache. */
  cached: boolean;
  /** Digest of {task content, baseSha} — root of this task's step chain. */
  implDigest: string;
}

export interface PoolOutcome {
  kind: 'blocked' | 'no-ready-task' | 'executed';
  spec: SpecDocument;
  state: RunState | null;
  detail?: string;
  /** Per-task outcomes, empty unless kind is 'executed'. */
  outcomes: ExecutorOutcome[];
}

/**
 * SPEC-PRD-0011-P3 T-01: dependency-ordered parallel task pool. Every task
 * whose dependsOn are all *merged* (not merely implemented) is eligible;
 * eligible tasks run concurrently — bounded by maxParallel — each in its
 * own worktree on its deterministic branch. A failed task blocks only its
 * dependents. The T-09 step cache carries over unchanged: cached
 * implementations are reused without re-invoking the agent, and editing a
 * task's spec content invalidates only that task's chain. Refuses to run
 * without an approval record (S-01 of P2, unchanged).
 */
export interface IExecutorService {
  executeReady(input: PoolInput): Promise<PoolOutcome>;
}

export const taskBranch = (runId: string, taskId: string): string =>
  `sdlc/${runId}/${taskId}`;

/** Digest rooting a task's step chain: task content + the base commit. */
export const implementationDigest = (task: SpecTask, baseSha: string): string =>
  inputsDigest({ task, baseSha });

const hasStep = (state: RunState, name: string, taskId: string): boolean =>
  Object.values(state.steps).some(
    step => step.name === name && step.taskId === taskId
  );

/** P3 dependency semantics: satisfied only by a *merged* dependency. */
const isMerged = (state: RunState, taskId: string): boolean =>
  state.taskResults[taskId]?.mergedSha !== undefined;

const selectReadyTasks = (
  spec: SpecDocument,
  state: RunState,
  maxParallel: number
): { task: SpecTask; implDigest: string }[] => {
  const ready: { task: SpecTask; implDigest: string }[] = [];
  for (const task of spec.tasks) {
    if (ready.length >= maxParallel) break;
    if (!task.dependsOn.every(dep => isMerged(state, dep))) continue;
    const digest = implementationDigest(task, state.baseSha);
    const result = state.taskResults[task.id];
    if (result !== undefined) {
      // A digest-less result predates the step graph: keep the pre-T-09
      // semantics (attempted once, never re-selected).
      if (result.inputsDigest === undefined) continue;
      if (result.status === 'failed') {
        // A failed attempt at the same content is not retried; a content
        // edit (different digest) makes the task eligible again.
        if (result.inputsDigest === digest) continue;
      } else if (result.inputsDigest === digest) {
        // Completed at the current content: done once the phase verdict
        // landed; otherwise resume the gate pipeline with the cached
        // implementation. A content edit reopens the task (invalidation).
        if (hasStep(state, 'phase', task.id)) continue;
      }
    }
    ready.push({ task, implDigest: digest });
  }
  return ready;
};

@injectable()
export class ExecutorService implements IExecutorService {
  constructor(
    @inject(WORKFLOW_TOKENS.SpecDocRepository)
    private readonly _specDocRepo: ISpecDocRepository,
    @inject(WORKFLOW_TOKENS.GitRepository)
    private readonly _gitRepo: IGitRepository,
    @inject(WORKFLOW_TOKENS.AgentRunnerRepository)
    private readonly _agentRepo: IAgentRunnerRepository,
    @inject(WORKFLOW_TOKENS.RunStateRepository)
    private readonly _runStateRepo: IRunStateRepository
  ) {}

  async executeReady(input: PoolInput): Promise<PoolOutcome> {
    const spec = this._specDocRepo.read(input.specPath);

    if (spec.status !== 'Approved') {
      // Refusal is recorded so the blocked run is visible to triage.
      const state = this.loadOrInitState(input, spec);
      this._runStateRepo.appendVerdict(input.runsDir, state, {
        gate: 'intake',
        outcome: 'blocked',
        wouldEscalate: true,
        reasons: ['unapproved-spec'],
        recordedAt: new Date().toISOString()
      });
      return {
        kind: 'blocked',
        spec,
        state,
        detail: 'unapproved-spec',
        outcomes: []
      };
    }

    const existing = this._runStateRepo.load(input.runsDir, input.runId);
    const state: RunState = existing ?? this.initState(input, spec);
    const selected = selectReadyTasks(spec, state, input.maxParallel);
    if (selected.length === 0) {
      // No side effects: nothing is persisted for a no-op invocation.
      return { kind: 'no-ready-task', spec, state: existing, outcomes: [] };
    }

    // Worktree creation mutates the shared .git directory — do it
    // sequentially; only the agent runs themselves fan out.
    const wave = selected.map(({ task, implDigest }) => ({
      task,
      implDigest,
      branch: taskBranch(input.runId, task.id),
      worktreePath: path.join(input.runsDir, input.runId, 'worktrees', task.id)
    }));
    for (const entry of wave) {
      if (!this.isImplementationCached(state, entry.task.id, entry.implDigest))
        this._gitRepo.addWorktree(
          input.repoPath,
          entry.worktreePath,
          entry.branch,
          state.baseSha
        );
    }

    const outcomes = await Promise.all(
      wave.map(entry => this.executeTask(input, spec, state, entry))
    );
    return { kind: 'executed', spec, state, outcomes };
  }

  private isImplementationCached(
    state: RunState,
    taskId: string,
    implDigest: string
  ): boolean {
    const implKey = stepKey('implementation', taskId, implDigest);
    return (
      state.steps[implKey] !== undefined &&
      state.taskResults[taskId]?.status === 'completed'
    );
  }

  private async executeTask(
    input: PoolInput,
    spec: SpecDocument,
    state: RunState,
    entry: {
      task: SpecTask;
      implDigest: string;
      branch: string;
      worktreePath: string;
    }
  ): Promise<ExecutorOutcome> {
    const { task, implDigest, branch, worktreePath } = entry;

    if (this.isImplementationCached(state, task.id, implDigest)) {
      // T-09: implementation cached — reuse the branch, skip the agent.
      return {
        kind: 'completed',
        task,
        branch: state.taskResults[task.id].branch ?? branch,
        detail: 'implementation reused from step cache',
        cached: true,
        implDigest
      };
    }

    const prompt = buildImplementationPrompt(spec, task);
    let ok = false;
    let detail = '';
    try {
      const result = await this._agentRepo.run(worktreePath, prompt);
      ok = result.ok;
      detail = result.ok ? '' : result.output;
    } catch (err) {
      detail = err instanceof Error ? err.message : String(err);
    }

    if (ok && this._gitRepo.headSha(worktreePath) === state.baseSha) {
      // Live-run finding (live-val-1): an agent can exit 0 having staged
      // work without committing, leaving an empty diff for every gate.
      // No commit means no implementation — record an honest failure.
      ok = false;
      const uncommitted = this._gitRepo.status(worktreePath).trim();
      detail =
        'implementation agent produced no commit' +
        (uncommitted.length > 0
          ? `; uncommitted changes left in worktree:\n${uncommitted}`
          : '');
    }

    // Mutations of the shared state object are synchronous, so concurrent
    // task completions serialize on the event loop — each recordTaskResult
    // persists the full accumulated state and none are lost.
    this._runStateRepo.recordTaskResult(input.runsDir, state, {
      taskId: task.id,
      status: ok ? 'completed' : 'failed',
      branch,
      worktreePath,
      inputsDigest: implDigest,
      detail: detail.length > 0 ? detail : undefined,
      recordedAt: new Date().toISOString()
    });
    if (ok) {
      this._runStateRepo.recordStep(
        input.runsDir,
        state,
        stepKey('implementation', task.id, implDigest),
        {
          name: 'implementation',
          taskId: task.id,
          inputsDigest: implDigest,
          completedAt: new Date().toISOString()
        }
      );
    }

    return {
      kind: ok ? 'completed' : 'failed',
      task,
      branch,
      detail: detail.length > 0 ? detail : undefined,
      cached: false,
      implDigest
    };
  }

  private initState(input: ExecutorInput, spec: SpecDocument): RunState {
    return {
      runId: input.runId,
      specId: spec.id,
      specPath: input.specPath,
      baseSha: this._gitRepo.headSha(input.repoPath),
      taskResults: {},
      verdicts: [],
      exceptions: [],
      criterionVerdicts: [],
      steps: {},
      tokenSpendK: 0,
      ciFixAttempts: {},
      updatedAt: new Date().toISOString()
    };
  }

  private loadOrInitState(input: ExecutorInput, spec: SpecDocument): RunState {
    return (
      this._runStateRepo.load(input.runsDir, input.runId) ??
      this.initState(input, spec)
    );
  }
}
