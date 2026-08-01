import { inject, injectable } from 'inversify';
import path from 'path';
import type { IAgentRunnerRepository } from '../repositories/agent-runner.repository';
import type { IGitRepository } from '../repositories/git.repository';
import type { IRunStateRepository } from '../repositories/run-state.repository';
import type { ISpecDocRepository } from '../repositories/spec-doc.repository';
import { WORKFLOW_TOKENS } from '../tokens';
import { RunState, SpecDocument, SpecTask } from '../types';
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
}

/**
 * SPEC-PRD-0011-P2 T-01: consume an approved spec, select exactly one ready
 * task (no parallelism this phase), execute the implementation agent in an
 * isolated worktree on a deterministic branch, and record a resumable
 * result. Refuses to run without an approval record — the S-01
 * no-code-before-approval invariant enforced at the execution boundary.
 */
export interface IExecutorService {
  executeNext(input: ExecutorInput): Promise<ExecutorOutcome>;
}

export const taskBranch = (runId: string, taskId: string): string =>
  `sdlc/${runId}/${taskId}`;

const selectReadyTask = (
  spec: SpecDocument,
  state: RunState
): SpecTask | undefined => {
  const completed = new Set(
    Object.values(state.taskResults)
      .filter(result => result.status === 'completed')
      .map(result => result.taskId)
  );
  return spec.tasks.find(
    task =>
      !(task.id in state.taskResults) &&
      task.dependsOn.every(dep => completed.has(dep))
  );
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
    const task = selectReadyTask(spec, state);
    if (task === undefined) {
      // No side effects: nothing is persisted for a no-op invocation.
      return { kind: 'no-ready-task', spec, state: existing };
    }

    const branch = taskBranch(input.runId, task.id);
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

    this._runStateRepo.recordTaskResult(input.runsDir, state, {
      taskId: task.id,
      status: ok ? 'completed' : 'failed',
      branch,
      worktreePath,
      detail: detail.length > 0 ? detail : undefined,
      recordedAt: new Date().toISOString()
    });

    return {
      kind: ok ? 'completed' : 'failed',
      spec,
      state,
      task,
      branch,
      detail: detail.length > 0 ? detail : undefined
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
