import { inject, injectable } from 'inversify';
import type { IAgentRunnerRepository } from '../repositories/agent-runner.repository';
import type { IGitRepository } from '../repositories/git.repository';
import type { IRunStateRepository } from '../repositories/run-state.repository';
import { WORKFLOW_TOKENS } from '../tokens';
import { Envelope, GateVerdict, RunState, SpecTask } from '../types';
import { agentSpendK } from '../utils/agent-spend';
import { budgetHaltDetail, isBudgetHalt } from '../utils/budget-halt';
import { buildGateFixPrompt } from '../utils/gate-fix-prompt';

export interface GateRemediationInput {
  /** Task worktree — the fix agent runs and commits here. */
  worktreePath: string;
  /** Task branch, pushed after a successful fix so CI and the PR follow. */
  branch: string;
  task: SpecTask;
  envelope: Envelope;
  runsDir: string;
  state: RunState;
  /** The red gate verdicts this round should address. */
  verdicts: GateVerdict[];
  /** Envelope token budget — remediation is skipped once spend exceeds it. */
  budgetK: number;
}

export type GateRemediationOutcome =
  /** A fix was committed and pushed; `sha` is the new task head. */
  | { kind: 'remediated'; attempt: number; sha: string; detail: string }
  /** Nothing was attempted (no remediable gate, budget or attempts spent). */
  | { kind: 'skipped'; attempt: number; detail: string }
  /** An attempt was spent but produced no usable commit. */
  | { kind: 'failed'; attempt: number; detail: string };

/**
 * Wave 0: turn a red *remediable* gate into another bounded agent round
 * instead of a terminal stop.
 *
 * @remarks
 * Reviewer disagreement and envelope breach were the two largest terminal
 * classes in the performance postmortem (14 and 8 of 44 escalations), and
 * both are the kind of finding an agent can act on — unlike a manual-tier
 * acceptance criterion, which genuinely needs a human. The reviewer itself
 * is cheap (median 1.16 min dispatch); what cost hours was that its
 * rejection ended the run.
 *
 * Two invariants matter for safety:
 *
 * - **Bounded.** {@link GATE_FIX_ATTEMPT_LIMIT} attempts per task,
 *   persisted in `state.gateFixAttempts` so a resume cannot refill the
 *   budget, and the envelope token budget still hard-stops dispatch.
 *   Exhaustion escalates loudly rather than spinning.
 * - **Findings carry forward.** Every prior round's reasons are replayed in
 *   the prompt, so the ping-pong failure mode — agent "fixes", reviewer
 *   objects to the same thing again — is at least visible to attempt N+1.
 *
 * This service does not decide whether to re-gate; it only produces a new
 * commit. The caller records the remediation, and task re-selection reopens
 * the task so the gates re-evaluate the new head.
 */
export interface IGateRemediationService {
  remediate(input: GateRemediationInput): Promise<GateRemediationOutcome>;
}

export const GATE_FIX_ATTEMPT_LIMIT = 2;

/**
 * Gates whose findings an agent can act on. `verification` is excluded on
 * purpose: a failing `manual:` criterion needs a human, and a failing
 * `test:` criterion is already the CI fix loop's job.
 */
const REMEDIABLE_GATES = new Set(['reviewer', 'envelope']);

/** The red verdicts an agent could plausibly clear, in report order. */
export const remediableVerdicts = (verdicts: GateVerdict[]): GateVerdict[] =>
  verdicts.filter(
    verdict => REMEDIABLE_GATES.has(verdict.gate) && verdict.outcome !== 'pass'
  );

@injectable()
export class GateRemediationService implements IGateRemediationService {
  constructor(
    @inject(WORKFLOW_TOKENS.AgentRunnerRepository)
    private readonly _agentRepo: IAgentRunnerRepository,
    @inject(WORKFLOW_TOKENS.GitRepository)
    private readonly _gitRepo: IGitRepository,
    @inject(WORKFLOW_TOKENS.RunStateRepository)
    private readonly _runStateRepo: IRunStateRepository
  ) {}

  async remediate(
    input: GateRemediationInput
  ): Promise<GateRemediationOutcome> {
    const taskId = input.task.id;
    const targets = remediableVerdicts(input.verdicts);
    const spent = input.state.gateFixAttempts?.[taskId] ?? 0;

    if (targets.length === 0) {
      return {
        kind: 'skipped',
        attempt: spent,
        detail: 'no remediable gate findings'
      };
    }
    if (spent >= GATE_FIX_ATTEMPT_LIMIT) {
      return {
        kind: 'skipped',
        attempt: spent,
        detail: `gate-fix attempts exhausted (${spent}/${GATE_FIX_ATTEMPT_LIMIT})`
      };
    }
    if (isBudgetHalt(input.state.tokenSpendK, input.budgetK)) {
      return {
        kind: 'skipped',
        attempt: spent,
        detail: budgetHaltDetail(input.state.tokenSpendK, input.budgetK)
      };
    }

    const attempt = this._runStateRepo.recordGateFixAttempt(
      input.runsDir,
      input.state,
      taskId
    );
    const before = this._gitRepo.headSha(input.worktreePath);
    const prompt = buildGateFixPrompt(
      input.task,
      input.envelope,
      targets,
      attempt,
      GATE_FIX_ATTEMPT_LIMIT,
      this.priorFindings(input.state, taskId)
    );

    let agentDetail = '';
    try {
      const result = await this._agentRepo.run(input.worktreePath, prompt);
      if (!result.ok) agentDetail = result.output.slice(0, 500);
    } catch (err) {
      agentDetail = err instanceof Error ? err.message : String(err);
    } finally {
      // The tokens were spent whether or not the dispatch succeeded.
      this._runStateRepo.recordTokenSpend(
        input.runsDir,
        input.state,
        agentSpendK()
      );
    }

    const committed = this.ensureCommit(input, before, attempt);
    if (committed === null) {
      return {
        kind: 'failed',
        attempt,
        detail:
          agentDetail.length > 0
            ? `no commit produced: ${agentDetail}`
            : 'remediation agent produced no commit'
      };
    }

    try {
      this._gitRepo.push(input.worktreePath, input.branch);
    } catch (err) {
      // The commit exists locally, so the attempt was not wasted — but the
      // gates judge the pushed ref, so an unpushed fix must not be reported
      // as remediated.
      return {
        kind: 'failed',
        attempt,
        detail: `fix committed at ${committed.slice(0, 12)} but push failed: ${
          err instanceof Error ? err.message : String(err)
        }`
      };
    }

    this._runStateRepo.recordRemediation(
      input.runsDir,
      input.state,
      taskId,
      committed,
      targets.map(verdict => verdict.gate)
    );

    return {
      kind: 'remediated',
      attempt,
      sha: committed,
      detail:
        `attempt ${attempt}/${GATE_FIX_ATTEMPT_LIMIT} addressed ` +
        `[${targets.map(verdict => verdict.gate).join(', ')}]: ` +
        `${before.slice(0, 12)} -> ${committed.slice(0, 12)}`
    };
  }

  /**
   * Reasons from every prior remediable red verdict for the task, so the
   * prompt can show attempt N+1 what N was already told.
   */
  private priorFindings(state: RunState, taskId: string): string[] {
    return remediableVerdicts(
      state.verdicts.filter(verdict => verdict.taskId === taskId)
    ).flatMap(verdict =>
      verdict.reasons.map(reason => `${verdict.gate}: ${reason}`)
    );
  }

  /**
   * Returns the new head SHA, or null when the agent left nothing usable.
   * Mirrors the executor's #41 salvage: husky rejects `sdlc/*` branches, so
   * a dirty worktree on the old head is committed by the engine with
   * `--no-verify -s` rather than thrown away.
   */
  private ensureCommit(
    input: GateRemediationInput,
    before: string,
    attempt: number
  ): string | null {
    const head = this._gitRepo.headSha(input.worktreePath);
    if (head !== before) return head;

    if (this._gitRepo.status(input.worktreePath).trim().length === 0) {
      return null;
    }
    try {
      this._gitRepo.stageAll(input.worktreePath);
      this._gitRepo.commit(
        input.worktreePath,
        `fix(${input.task.id}): address gate findings (attempt ${attempt})`,
        { noVerify: true, signOff: true }
      );
      return this._gitRepo.headSha(input.worktreePath);
    } catch {
      return null;
    }
  }
}
