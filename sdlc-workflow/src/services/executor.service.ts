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

export interface ExecutorOutcome {
  kind: 'blocked' | 'no-ready-task' | 'completed' | 'failed';
  spec: SpecDocument;
  state: RunState | null;
  task?: SpecTask;
  branch?: string;
  detail?: string;
  /** True when the implementation step was reused from the T-09 cache. */
  cached?: boolean;
  /** Digest of {task content, baseSha} — root of this task's step chain. */
  implDigest?: string;
}

/**
 * SPEC-PRD-0011-P2 T-01 + T-09: consume an approved spec, select exactly one
 * task whose pipeline is incomplete (no parallelism this phase), and execute
 * the implementation agent in an isolated worktree — unless the T-09 step
 * cache already holds a result for this exact task content and base SHA, in
 * which case the cached branch is reused without re-invoking the agent.
 * Editing a task's spec content changes its digest and invalidates only that
 * task's chain. Refuses to run without an approval record (S-01).
 */
export interface IExecutorService {
  executeNext(input: ExecutorInput): Promise<ExecutorOutcome>;
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

const selectReadyTask = (
  spec: SpecDocument,
  state: RunState
): { task: SpecTask; implDigest: string } | undefined => {
  const completed = new Set(
    Object.values(state.taskResults)
      .filter(result => result.status === 'completed')
      .map(result => result.taskId)
  );
  for (const task of spec.tasks) {
    if (!task.dependsOn.every(dep => completed.has(dep))) continue;
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
    return { task, implDigest: digest };
  }
  return undefined;
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

  async executeNext(input: ExecutorInput): Promise<ExecutorOutcome> {
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
      return { kind: 'blocked', spec, state, detail: 'unapproved-spec' };
    }

    const existing = this._runStateRepo.load(input.runsDir, input.runId);
    const state: RunState = existing ?? this.initState(input, spec);
    const selected = selectReadyTask(spec, state);
    if (selected === undefined) {
      // No side effects: nothing is persisted for a no-op invocation.
      return { kind: 'no-ready-task', spec, state: existing };
    }
    const { task, implDigest } = selected;

    const branch = taskBranch(input.runId, task.id);
    const implKey = stepKey('implementation', task.id, implDigest);
    if (
      state.steps[implKey] !== undefined &&
      state.taskResults[task.id]?.status === 'completed'
    ) {
      // T-09: implementation cached — reuse the branch, skip the agent.
      return {
        kind: 'completed',
        spec,
        state,
        task,
        branch: state.taskResults[task.id].branch,
        detail: 'implementation reused from step cache',
        cached: true,
        implDigest
      };
    }

    const worktreePath = path.join(
      input.runsDir,
      input.runId,
      'worktrees',
      task.id
    );
    this._gitRepo.addWorktree(
      input.repoPath,
      worktreePath,
      branch,
      state.baseSha
    );

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
      this._runStateRepo.recordStep(input.runsDir, state, implKey, {
        name: 'implementation',
        taskId: task.id,
        inputsDigest: implDigest,
        completedAt: new Date().toISOString()
      });
    }

    return {
      kind: ok ? 'completed' : 'failed',
      spec,
      state,
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
