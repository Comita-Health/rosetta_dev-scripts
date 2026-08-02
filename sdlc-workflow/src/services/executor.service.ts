import { inject, injectable } from 'inversify';
import path from 'path';
import type { IAgentRunnerRepository } from '../repositories/agent-runner.repository';
import type { IGitRepository } from '../repositories/git.repository';
import type { IRunStateRepository } from '../repositories/run-state.repository';
import type { ISpecDocRepository } from '../repositories/spec-doc.repository';
import { WORKFLOW_TOKENS } from '../tokens';
import { RunState, SpecDocument, SpecTask, stepKey } from '../types';
import { agentSpendK } from '../utils/agent-spend';
import { inputsDigest } from '../utils/digest';
import { buildImplementationPrompt } from '../utils/implementation-prompt';
import { taskIntegrationTip } from '../utils/task-base';

export interface ExecutorInput {
  specPath: string;
  repoPath: string;
  runId: string;
  runsDir: string;
}

/** Optional progress sink for native heartbeat (#39) — not a Service call. */
export interface ProgressSink {
  set(ctx: {
    taskId: string;
    step: string;
    worktreePath?: string;
    lastLine?: string;
  }): void;
}

export interface PoolInput extends ExecutorInput {
  /** Upper bound on concurrently running implementation agents. */
  maxParallel: number;
  /** Called as the pool enters implementation steps (heartbeat #39). */
  progress?: ProgressSink;
}

/** Per-task outcome of one pool wave. */
export interface ExecutorOutcome {
  kind: 'completed' | 'failed';
  task: SpecTask;
  branch: string;
  detail?: string;
  /** True when the implementation step was reused from the T-09 cache. */
  cached: boolean;
  /** Digest of {task content, integration tip} — root of this task's step chain. */
  implDigest: string;
  /**
   * Tip the worktree was branched from and envelope/reviewer must diff
   * against (#42 / F1) — never a cumulative frozen-base mega-diff.
   */
  baseSha: string;
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

/** Digest rooting a task's step chain: task content + the integration tip. */
export const implementationDigest = (task: SpecTask, baseSha: string): string =>
  inputsDigest({ task, baseSha });

const hasStep = (state: RunState, name: string, taskId: string): boolean =>
  Object.values(state.steps).some(
    step => step.name === name && step.taskId === taskId
  );

/**
 * Latest phase step for a task (by completedAt). Used so a green phase with
 * a failed merge call can re-enter the gate pipeline without reopening
 * breach-terminal tasks (Comita Phase 0b: conflict → fix → resume).
 */
const latestPhaseStep = (state: RunState, taskId: string) => {
  const phases = Object.values(state.steps).filter(
    step => step.name === 'phase' && step.taskId === taskId
  );
  if (phases.length === 0) {
    return undefined;
  }
  return phases.reduce((best, step) =>
    step.completedAt > best.completedAt ? step : best
  );
};

/** P3 dependency semantics: satisfied only by a *merged* dependency. */
const isMerged = (state: RunState, taskId: string): boolean =>
  state.taskResults[taskId]?.mergedSha !== undefined;

const selectReadyTasks = (
  spec: SpecDocument,
  state: RunState,
  maxParallel: number
): { task: SpecTask; implDigest: string; baseSha: string }[] => {
  const ready: { task: SpecTask; implDigest: string; baseSha: string }[] = [];
  for (const task of spec.tasks) {
    if (ready.length >= maxParallel) break;
    // Merged tasks are terminal — tip advances (#42/#44) change the
    // implementation digest root, which must NOT reopen a task that
    // already landed on the integration branch (Comita live-val shadow-2:
    // re-running T-02 after record-merge → empty diff + reviewer breach).
    if (isMerged(state, task.id)) continue;
    if (!task.dependsOn.every(dep => isMerged(state, dep))) continue;
    const tip = taskIntegrationTip(state, task);
    const digest = implementationDigest(task, tip);
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
        // Completed at the current content: resume the gate pipeline until
        // phase lands. After a *pass* phase with no merge step, re-select
        // so enforce can retry `gh pr merge` (dirty PR / flaky API). A
        // *breach* phase stays terminal for this digest.
        const phase = latestPhaseStep(state, task.id);
        if (phase !== undefined) {
          const passed = phase.verdict?.outcome === 'pass';
          const mergeDone = hasStep(state, 'merge', task.id);
          if (!passed || mergeDone) {
            continue;
          }
        }
      }
    }
    ready.push({ task, implDigest: digest, baseSha: tip });
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
    // sequentially; only the agent runs themselves fan out. Tip is the
    // post-merge integration SHA when deps are merged (#42), not the
    // frozen run baseSha.
    const wave = selected.map(({ task, implDigest, baseSha }) => ({
      task,
      implDigest,
      baseSha,
      branch: taskBranch(input.runId, task.id),
      worktreePath: path.join(input.runsDir, input.runId, 'worktrees', task.id)
    }));
    const needsWorktree = wave.some(
      entry =>
        !this.isImplementationCached(state, entry.task.id, entry.implDigest)
    );
    // Belt-and-suspenders with post-merge fetch in enforcement: a resume
    // after an older engine tip (or external record-merge) may still lack
    // the tip object locally.
    if (needsWorktree) {
      this._gitRepo.fetch(input.repoPath);
    }
    for (const entry of wave) {
      if (!this.isImplementationCached(state, entry.task.id, entry.implDigest))
        this._gitRepo.addWorktree(
          input.repoPath,
          entry.worktreePath,
          entry.branch,
          entry.baseSha
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
      baseSha: string;
      branch: string;
      worktreePath: string;
    }
  ): Promise<ExecutorOutcome> {
    const { task, implDigest, baseSha, branch, worktreePath } = entry;

    if (this.isImplementationCached(state, task.id, implDigest)) {
      // T-09: implementation cached — reuse the branch, skip the agent.
      return {
        kind: 'completed',
        task,
        branch: state.taskResults[task.id].branch ?? branch,
        detail: 'implementation reused from step cache',
        cached: true,
        implDigest,
        baseSha
      };
    }

    // P3 T-06: budget exhaustion halts new agent dispatches pool-wide.
    // In-flight non-agent steps (worktree creation above, gates later)
    // still complete — only the agent call is skipped.
    if (state.tokenSpendK > spec.envelope.budgetK) {
      const detail = `budget exhausted: spend ${state.tokenSpendK}k exceeds budget ${spec.envelope.budgetK}k`;
      this._runStateRepo.recordTaskResult(input.runsDir, state, {
        taskId: task.id,
        status: 'failed',
        branch,
        worktreePath,
        inputsDigest: implDigest,
        detail,
        recordedAt: new Date().toISOString()
      });
      if (
        !state.exceptions.some(
          entry =>
            entry.trigger === 'budget-exhaustion' && entry.taskId === task.id
        )
      ) {
        this._runStateRepo.recordExceptions(input.runsDir, state, [
          {
            trigger: 'budget-exhaustion',
            taskId: task.id,
            context: [detail],
            recordedAt: new Date().toISOString()
          }
        ]);
      }
      return {
        kind: 'failed',
        task,
        branch,
        detail,
        cached: false,
        implDigest,
        baseSha
      };
    }

    input.progress?.set({
      taskId: task.id,
      step: 'implementation',
      worktreePath,
      lastLine: 'dispatching implementation agent'
    });

    const prompt = buildImplementationPrompt(spec, task);
    let ok = false;
    let detail = '';
    try {
      const result = await this._agentRepo.run(worktreePath, prompt);
      // Meter the dispatch whether it succeeded or failed — the tokens
      // were spent either way.
      this._runStateRepo.recordTokenSpend(input.runsDir, state, agentSpendK());
      ok = result.ok;
      detail = result.ok ? '' : result.output;
    } catch (err) {
      this._runStateRepo.recordTokenSpend(input.runsDir, state, agentSpendK());
      detail = err instanceof Error ? err.message : String(err);
    }

    const commitOutcome = this.ensureEngineCommit(
      worktreePath,
      baseSha,
      task,
      ok,
      detail
    );
    ok = commitOutcome.ok;
    detail = commitOutcome.detail;

    // A clean worktree with no commit is terminal at this content digest —
    // re-running selects nothing. Record it so the run surfaces a task that
    // would otherwise just be missing from the wave.
    if (commitOutcome.noCommit === true) {
      this._runStateRepo.recordExceptions(input.runsDir, state, [
        {
          trigger: 'no-commit',
          taskId: task.id,
          context: [detail.slice(0, 500)],
          recordedAt: new Date().toISOString()
        }
      ]);
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
      implDigest,
      baseSha
    };
  }

  /**
   * #41: when the agent leaves a dirty worktree on the tip (common when
   * husky rejects `sdlc/*` branches), the engine owns the commit with
   * `--no-verify -s` so gates can proceed. A clean tip with no commit is
   * still an honest failure.
   */
  private ensureEngineCommit(
    worktreePath: string,
    tipSha: string,
    task: SpecTask,
    agentOk: boolean,
    agentDetail: string
  ): { ok: boolean; detail: string; noCommit?: boolean } {
    const head = this._gitRepo.headSha(worktreePath);
    if (head !== tipSha) {
      return { ok: agentOk, detail: agentDetail };
    }

    const uncommitted = this._gitRepo.status(worktreePath).trim();
    if (uncommitted.length === 0) {
      return {
        ok: false,
        noCommit: true,
        detail:
          agentDetail.length > 0
            ? agentDetail
            : 'implementation agent produced no commit'
      };
    }

    try {
      this._gitRepo.stageAll(worktreePath);
      this._gitRepo.commit(worktreePath, `feat(${task.id}): ${task.title}`, {
        noVerify: true,
        signOff: true
      });
      const note = 'engine committed dirty worktree (--no-verify)';
      return {
        ok: true,
        detail:
          agentDetail.length > 0 && agentOk === false
            ? `${agentDetail}; ${note}`
            : note
      };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        detail:
          'implementation agent produced no commit; engine commit failed: ' +
          reason.slice(0, 300) +
          (uncommitted.length > 0
            ? `\nuncommitted changes:\n${uncommitted}`
            : '')
      };
    }
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
