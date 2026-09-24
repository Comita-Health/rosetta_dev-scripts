import { inject, injectable } from 'inversify';
import type { IAgentRunnerRepository } from '../repositories/agent-runner.repository';
import type { IGitRepository } from '../repositories/git.repository';
import type { IRunStateRepository } from '../repositories/run-state.repository';
import { WORKFLOW_TOKENS } from '../tokens';
import {
  Envelope,
  GateVerdict,
  OperatorUnstickOutcome,
  RunState,
  SpecTask
} from '../types';
import { agentSpendK } from '../utils/agent-spend';
import { buildOperatorUnstickPrompt } from '../utils/operator-unstick-prompt';
import { isSpecTreePath } from '../utils/spec-path';
import type { RiskyClassificationSource } from './advisory-issue.service';
import {
  GATE_FIX_ATTEMPT_LIMIT,
  remediableVerdicts,
  type GateRemediationOutcome
} from './gate-remediation.service';

export interface OperatorUnstickInput {
  /** Task worktree — the unstick agent runs here (no chat/session). */
  worktreePath: string;
  /** Task branch, used when unstick needs push / record-merge follow-up. */
  branch: string;
  task: SpecTask;
  envelope: Envelope;
  runsDir: string;
  state: RunState;
  /** Red gate verdicts that exhausted remediable remediation. */
  verdicts: GateVerdict[];
  /** Envelope token budget — unstick is skipped once spend exceeds it. */
  budgetK: number;
}

/**
 * SPEC-PRD-0025-P1 T-01 / T-03 / T-04: result of one operator-unstick turn.
 * Outcome kinds mirror {@link OperatorUnstickOutcome}; `skipped` means the
 * service did not spend an attempt (budget / not applicable).
 * `risky-proceed` always names who classified (agent label vs engine
 * strategy classification) so the advisory path can attribute correctly.
 */
export type OperatorUnstickResult =
  | {
      kind: 'risky-proceed';
      attempt: number;
      detail: string;
      classifiedBy: RiskyClassificationSource;
    }
  | {
      kind: Exclude<OperatorUnstickOutcome, 'risky-proceed'>;
      attempt: number;
      detail: string;
    }
  | { kind: 'skipped'; attempt: number; detail: string };

/**
 * Headless operator-unstick after remediable gate remediation exhausts
 * (SPEC-PRD-0025-P1). Distinct from {@link GateRemediationService}: mandate
 * is rebase / integration tip, out-of-band merge + record-merge, and resume
 * — not trim-the-diff remediation.
 *
 * Dispatch runs on the local supervise/daemon path via
 * {@link IAgentRunnerRepository} — no chat/session object.
 */
export interface IOperatorUnstickService {
  unstick(input: OperatorUnstickInput): Promise<OperatorUnstickResult>;
}

/** Per-task unstick attempt budget; persisted on RunState like gate fixes. */
export const OPERATOR_UNSTICK_ATTEMPT_LIMIT = 2;

/**
 * True when gate remediation returned skipped/failed for exhausted remediable
 * reviewer|envelope findings — the sole precondition for operator-unstick
 * dispatch (SPEC-PRD-0025-P1 T-03). Non-remediable skips and in-budget
 * remediation failures must not trigger unstick.
 */
export const shouldDispatchOperatorUnstick = (
  remediation: GateRemediationOutcome,
  verdicts: GateVerdict[],
  state: RunState,
  taskId: string
): boolean => {
  if (remediation.kind === 'remediated') return false;
  if (remediableVerdicts(verdicts).length === 0) return false;
  // Only remediable gate-fix exhaustion — not token-budget skips that
  // happen to include "budget exhausted" while attempts remain.
  const spent = state.gateFixAttempts?.[taskId] ?? 0;
  return spent >= GATE_FIX_ATTEMPT_LIMIT;
};

/** Outcomes that suppress human-blocking ACTION REQUIRED for the wave. */
export const suppressesBlockingEscalate = (
  kind: OperatorUnstickResult['kind']
): boolean => kind === 'cleared' || kind === 'risky-proceed';

/**
 * True when the engine classifies the agent's chosen strategy as risky even
 * without an agent `risky-proceed` self-label (SPEC-PRD-0025-P1 T-04).
 *
 * @remarks
 * Agents may write `OUTCOME: risky-advisory` (or describe a proceed under a
 * named risky assumption). Only the engine turns that into `risky-proceed` —
 * policy-rewrite turns are already fail-closed to `abstained` before this
 * runs, so Approved-artifact edits cannot self-authorize via this path.
 *
 * A bare `risky-advisory` token is intentionally **not** enough: the
 * operator-unstick prompt itself names that path next to abstain guidance,
 * so prompt echo / restatement on an `OUTCOME: abstained` (or last-attempt
 * exhaust) turn must not suppress ACTION REQUIRED. Abstain / authority-bound
 * language is excluded the same way as the risky-assumption arm.
 */
export const engineClassifiesStrategyAsRisky = (
  agentOutput: string
): boolean => {
  const text = agentOutput;
  // Explicit abstain / authority markers win over a proceed marker in the
  // same turn (fail closed). `classifyOperatorUnstickOutcome` also
  // short-circuits these before calling this helper.
  if (
    /\boutcome\s*[:=]\s*abstained\b/i.test(text) ||
    /\boutcome\s*[:=]\s*authority-bound\b/i.test(text)
  ) {
    return false;
  }
  // Explicit outcome marker only — never a bare substring match. Prompt
  // echo of the word `risky-advisory` must not continue.
  if (/\boutcome\s*[:=]\s*risky-advisory\b/i.test(text)) {
    return true;
  }
  // Heuristic arm — fail closed on abstain / authority-bound language
  // (same exclusions as before; do not apply them to the OUTCOME marker).
  if (/\babstain/i.test(text) || /\bauthority-bound\b/i.test(text)) {
    return false;
  }
  // Named risky-assumption proceed without a blocking abstain/authority marker.
  if (
    /\brisky\s+assumption\b/i.test(text) &&
    (/\bproceed/i.test(text) || /\bcontinu/i.test(text))
  ) {
    return true;
  }
  return false;
};

/**
 * Who classified a `risky-proceed` outcome — agent self-label vs engine
 * strategy classification. Used by the advisory continue path.
 *
 * @remarks
 * Agent attribution requires the explicit `OUTCOME: risky-proceed` marker.
 * A bare `risky-proceed` token is not enough (prompt echo).
 */
export const classifyRiskyProceedSource = (
  agentOutput: string
): RiskyClassificationSource =>
  /\boutcome\s*[:=]\s*risky-proceed\b/i.test(agentOutput)
    ? 'agent'
    : 'engine';
/**
 * True when agent output carries an explicit cleared outcome marker, not
 * negatives like "not yet cleared" / "uncleared".
 *
 * @remarks
 * A bare `/\bcleared\b/` match is intentionally rejected — strings such as
 * "not yet cleared … resume later" must not suppress ACTION REQUIRED.
 */
const hasClearedMarker = (text: string): boolean => {
  const lower = text.toLowerCase();
  if (
    /\bnot(?:\s+\w+){0,3}\s+cleared\b/i.test(lower) ||
    /\b(?:un|never\s+)cleared\b/i.test(lower) ||
    /\babstain/i.test(text)
  ) {
    return false;
  }
  return /\boutcome\s*[:=]\s*cleared\b/i.test(text);
};

/**
 * Classify the agent turn into a durable outcome.
 *
 * @remarks
 * `cleared` requires durable blocker-clear evidence — `mergedSha` /
 * record-merge on run state (reloaded from disk after the agent turn), or
 * an explicit `OUTCOME: cleared` marker plus a successful HEAD move
 * (rebase / integration tip). Agent text alone (cleared marker + resume
 * wording) is never enough; a bare `cleared` token or HEAD movement alone
 * is not enough (committed policy rewrites also move HEAD). When
 * `policyRewriteAttempt` is true (including fail-closed audit blindness),
 * the outcome is always `abstained` — agent `risky-proceed` text cannot
 * suppress ACTION REQUIRED.
 */
export const classifyOperatorUnstickOutcome = (args: {
  agentOutput: string;
  attempt: number;
  attemptLimit: number;
  taskMerged: boolean;
  headMoved: boolean;
  policyRewriteAttempt: boolean;
}): OperatorUnstickOutcome => {
  const text = args.agentOutput;
  const lower = text.toLowerCase();

  // Mid-run specs/** / envelope edits (and fail-closed audit blindness)
  // always abstain — never let agent risky-proceed / risky-advisory text
  // self-authorize and suppress ACTION REQUIRED (T-02 / T-03).
  if (args.policyRewriteAttempt) {
    return 'abstained';
  }

  if (
    /\boutcome\s*[:=]\s*authority-bound\b/i.test(text) ||
    /\bauthority-bound\b/i.test(text)
  ) {
    return 'authority-bound';
  }
  // Abstain language naming an authority-bound act.
  if (
    /\babstain(?:ed|ing)?\b/i.test(text) &&
    (/draft\s*→\s*approved/i.test(text) ||
      /draft.*approved/i.test(lower) ||
      /\bphi\b/i.test(text) ||
      /smoke/i.test(text) ||
      /veto/i.test(text) ||
      /check-veto/i.test(text))
  ) {
    return 'authority-bound';
  }

  // Explicit abstain marker before any continue classification — so
  // restating prompt guidance about risky-advisory / risky-proceed cannot
  // override `OUTCOME: abstained` into a false continue.
  if (/\boutcome\s*[:=]\s*abstained\b/i.test(text)) {
    return 'abstained';
  }

  // Agent self-label — explicit OUTCOME marker only (bare `risky-proceed`
  // appears in the unstick prompt next to abstain instructions).
  if (/\boutcome\s*[:=]\s*risky-proceed\b/i.test(text)) {
    return 'risky-proceed';
  }

  // Engine classifies the chosen strategy as risky (e.g. agent wrote
  // OUTCOME: risky-advisory without self-labeling risky-proceed). Distinct
  // from the agent-labeled branch above; production continue+advisory uses
  // classifiedBy: 'engine' (SPEC-PRD-0025-P1 T-04).
  if (engineClassifiesStrategyAsRisky(text)) {
    return 'risky-proceed';
  }

  const clearedMarker = hasClearedMarker(text);
  // Durable evidence only — never agent text / resume wording alone.
  const blockerClearEvidence =
    args.taskMerged || (clearedMarker && args.headMoved);

  if (blockerClearEvidence) {
    return 'cleared';
  }

  if (/\babstain(?:ed|ing)?\b/i.test(text)) {
    return 'abstained';
  }

  if (args.attempt >= args.attemptLimit) {
    return 'exhausted';
  }

  return 'abstained';
};

@injectable()
export class OperatorUnstickService implements IOperatorUnstickService {
  constructor(
    @inject(WORKFLOW_TOKENS.AgentRunnerRepository)
    private readonly _agentRepo: IAgentRunnerRepository,
    @inject(WORKFLOW_TOKENS.GitRepository)
    private readonly _gitRepo: IGitRepository,
    @inject(WORKFLOW_TOKENS.RunStateRepository)
    private readonly _runStateRepo: IRunStateRepository
  ) {}

  /**
   * Dispatch one headless operator-unstick agent turn after remediable gate
   * remediation has exhausted (SPEC-PRD-0025-P1 T-03).
   *
   * @remarks
   * **Purpose.** Give the local supervise/daemon path a bounded chance to
   * clear routine sticks (rebase / integration tip, out-of-band merge +
   * `record-merge`, resume) before posting a human-blocking ACTION REQUIRED
   * issue. {@link IAgentRunnerRepository.run} is invoked with cwd + prompt
   * only — no chat/session object.
   *
   * **Invariants.**
   * - Escalate tier is set to `unstick-in-flight` for the duration of the
   *   turn so status/monitor can show the wave is not yet human-blocked.
   * - When HEAD moves, the tip is pushed so re-selection / resume sees it
   *   (mirrors gate-remediation); a push failure is not treated as a clear.
   * - Mid-run `specs/**` or envelope-limit rewrites — dirty **or** committed
   *   during the turn — always route to `abstained`, never `cleared` or
   *   `risky-proceed` (agent text cannot self-authorize advisory proceed).
   *   Policy detection is fail-closed: when `status` / `diffStat` /
   *   `diffText` throws, the turn is treated as a policy-rewrite attempt
   *   rather than a silent clear or risky-proceed.
   * - After the agent turn, `mergedSha` is reloaded from disk onto the
   *   in-memory {@link RunState} so a subprocess `record-merge` is visible
   *   even when HEAD did not move.
   * - `cleared` / `risky-proceed` suppress blocking escalate for the wave;
   *   `abstained` / `exhausted` / `authority-bound` fall through to the
   *   existing escalate + issue-state watch path.
   *
   * **Failure modes.**
   * - `skipped` — no remediable findings, or envelope token budget already
   *   spent (no attempt recorded).
   * - `exhausted` — per-task unstick attempt budget already spent; tier
   *   becomes `halted-escalated` without dispatching.
   * - Agent throw / empty failure — output is classified; typically
   *   `abstained` unless the attempt budget is spent.
   * - Policy-rewrite detection (including inspection errors) or missing
   *   durable blocker-clear evidence — never suppress ACTION REQUIRED for
   *   that wave.
   */
  async unstick(input: OperatorUnstickInput): Promise<OperatorUnstickResult> {
    const taskId = input.task.id;
    const targets = remediableVerdicts(input.verdicts);
    const spent = input.state.operatorUnstickAttempts?.[taskId] ?? 0;

    if (targets.length === 0) {
      return {
        kind: 'skipped',
        attempt: spent,
        detail: 'no remediable gate findings for unstick'
      };
    }
    if (spent >= OPERATOR_UNSTICK_ATTEMPT_LIMIT) {
      this._runStateRepo.recordOperatorUnstickOutcome(
        input.runsDir,
        input.state,
        taskId,
        'exhausted',
        `operator-unstick attempts exhausted (${spent}/${OPERATOR_UNSTICK_ATTEMPT_LIMIT})`
      );
      this._runStateRepo.recordEscalateTier(
        input.runsDir,
        input.state,
        taskId,
        'halted-escalated'
      );
      return {
        kind: 'exhausted',
        attempt: spent,
        detail: `operator-unstick attempts exhausted (${spent}/${OPERATOR_UNSTICK_ATTEMPT_LIMIT})`
      };
    }
    if (input.state.tokenSpendK > input.budgetK) {
      return {
        kind: 'skipped',
        attempt: spent,
        detail:
          `budget exhausted: spend ${input.state.tokenSpendK}k exceeds ` +
          `budget ${input.budgetK}k`
      };
    }

    // Status surfaces see unstick-in-flight for the duration of the turn.
    this._runStateRepo.recordEscalateTier(
      input.runsDir,
      input.state,
      taskId,
      'unstick-in-flight'
    );

    const attempt = this._runStateRepo.recordOperatorUnstickAttempt(
      input.runsDir,
      input.state,
      taskId
    );
    const before = this._gitRepo.headSha(input.worktreePath);
    const prompt = buildOperatorUnstickPrompt(
      input.task,
      input.envelope,
      targets,
      attempt,
      OPERATOR_UNSTICK_ATTEMPT_LIMIT
    );

    let agentOutput = '';
    try {
      // Headless local dispatch — AgentRunnerRepository needs only cwd + prompt.
      const result = await this._agentRepo.run(input.worktreePath, prompt);
      agentOutput = result.output;
      if (!result.ok && agentOutput.length === 0) {
        agentOutput = 'agent dispatch failed';
      }
    } catch (err) {
      agentOutput = err instanceof Error ? err.message : String(err);
    } finally {
      this._runStateRepo.recordTokenSpend(
        input.runsDir,
        input.state,
        agentSpendK()
      );
    }

    // Push any rebase/integration tip the agent left on the worktree so
    // re-selection / resume sees the new head (mirrors gate-remediation).
    const after = this._gitRepo.headSha(input.worktreePath);
    const headMoved = after !== before;
    if (headMoved) {
      try {
        this._gitRepo.push(input.worktreePath, input.branch);
      } catch (err) {
        agentOutput =
          `${agentOutput}\npush failed after unstick: ` +
          (err instanceof Error ? err.message : String(err));
      }
    }

    // Subprocess record-merge writes mergedSha to disk; the in-memory
    // RunState the handler handed us will not see it unless we reload.
    this.syncMergedShaFromDisk(input, taskId);
    const taskMerged =
      (input.state.taskResults[taskId]?.mergedSha ?? '').length > 0;
    const policyRewriteAttempt = this.detectPolicyRewriteAttempt(
      input.worktreePath,
      before,
      after
    );

    const kind = classifyOperatorUnstickOutcome({
      agentOutput,
      attempt,
      attemptLimit: OPERATOR_UNSTICK_ATTEMPT_LIMIT,
      taskMerged,
      headMoved:
        headMoved && !agentOutput.toLowerCase().includes('push failed'),
      policyRewriteAttempt
    });

    const detail = this.detailFor(kind, attempt, agentOutput);
    this._runStateRepo.recordOperatorUnstickOutcome(
      input.runsDir,
      input.state,
      taskId,
      kind,
      detail
    );
    this.applyTerminalTier(input, taskId, kind);

    if (kind === 'risky-proceed') {
      return {
        kind,
        attempt,
        detail,
        classifiedBy: classifyRiskyProceedSource(agentOutput)
      };
    }
    return { kind, attempt, detail };
  }

  private applyTerminalTier(
    input: OperatorUnstickInput,
    taskId: string,
    kind: OperatorUnstickOutcome
  ): void {
    if (kind === 'risky-proceed') {
      this._runStateRepo.recordEscalateTier(
        input.runsDir,
        input.state,
        taskId,
        'advisory-risky'
      );
      return;
    }
    if (
      kind === 'abstained' ||
      kind === 'exhausted' ||
      kind === 'authority-bound'
    ) {
      this._runStateRepo.recordEscalateTier(
        input.runsDir,
        input.state,
        taskId,
        'halted-escalated'
      );
      return;
    }
    // cleared — drop in-flight tier so status does not linger.
    if (input.state.escalateTiers !== undefined) {
      delete input.state.escalateTiers[taskId];
      this._runStateRepo.save(input.runsDir, input.state);
    }
  }

  private detailFor(
    kind: OperatorUnstickOutcome,
    attempt: number,
    agentOutput: string
  ): string {
    const snippet = agentOutput.replace(/\s+/g, ' ').trim().slice(0, 240);
    const base = `attempt ${attempt}/${OPERATOR_UNSTICK_ATTEMPT_LIMIT} → ${kind}`;
    return snippet.length > 0 ? `${base}: ${snippet}` : base;
  }

  /**
   * Copy `mergedSha` written by a subprocess (e.g. `record-merge`) from
   * disk onto the caller's in-memory {@link RunState}.
   */
  private syncMergedShaFromDisk(
    input: OperatorUnstickInput,
    taskId: string
  ): void {
    const reloaded = this._runStateRepo.load(input.runsDir, input.state.runId);
    if (reloaded === null) {
      return;
    }
    const diskTask = reloaded.taskResults[taskId];
    const diskMerged = diskTask?.mergedSha;
    if (diskMerged !== undefined && diskMerged.length > 0) {
      const mem = input.state.taskResults[taskId];
      if (mem !== undefined) {
        mem.mergedSha = diskMerged;
      } else if (diskTask !== undefined) {
        input.state.taskResults[taskId] = { ...diskTask };
      }
    }
    if (reloaded.mergedSha !== undefined && reloaded.mergedSha.length > 0) {
      input.state.mergedSha = reloaded.mergedSha;
    }
  }

  /**
   * Detect an unstick turn that tried to rewrite Approved policy (mid-run
   * `specs/**` closeout or envelope limits).
   *
   * @remarks
   * Inspects both a dirty worktree **and** the committed range
   * `beforeSha..afterSha`. A clean tree after a committed `specs/**` rewrite
   * must still route to abstain — otherwise `headMoved` would look like a
   * successful tip clear.
   *
   * Fail-closed: when `status` / `diffStat` / `diffText` throws, return
   * `true` so classification cannot grant `cleared` while the audit is
   * blind (a committed mid-run specs/** rewrite that moved HEAD must not
   * suppress ACTION REQUIRED).
   */
  private detectPolicyRewriteAttempt(
    worktreePath: string,
    beforeSha: string,
    afterSha: string
  ): boolean {
    try {
      if (this.dirtyPathsIndicatePolicyRewrite(worktreePath)) {
        return true;
      }
    } catch {
      // Cannot audit the dirty tree — fail closed rather than assume clean.
      return true;
    }
    if (beforeSha === afterSha) {
      return false;
    }
    try {
      const diff = this._gitRepo.diffStat(worktreePath, beforeSha, afterSha);
      if (diff.files.some(file => this.isPolicyRewritePath(file.path))) {
        return true;
      }
      const text = this._gitRepo.diffText(worktreePath, beforeSha, afterSha);
      return this.diffIndicatesEnvelopeLimitRewrite(text);
    } catch {
      // HEAD moved but the committed range cannot be audited — fail closed.
      return true;
    }
  }

  private dirtyPathsIndicatePolicyRewrite(worktreePath: string): boolean {
    const status = this._gitRepo.status(worktreePath);
    if (status.trim().length === 0) return false;
    const lines = status.split('\n').map(line => line.trimEnd());
    for (const line of lines) {
      // git status --porcelain: XY PATH or XY ORIG -> PATH
      const pathPart = line.length >= 3 ? line.slice(3).trim() : line;
      const rel = pathPart.includes(' -> ')
        ? (pathPart.split(' -> ').pop() ?? pathPart)
        : pathPart;
      if (this.isPolicyRewritePath(rel)) {
        return true;
      }
    }
    return false;
  }

  private isPolicyRewritePath(rel: string): boolean {
    return (
      isSpecTreePath(rel) ||
      /maxDiffLines/.test(rel) ||
      /allowedPaths/.test(rel)
    );
  }

  /** Added envelope-limit lines in a committed diff (content, not path). */
  private diffIndicatesEnvelopeLimitRewrite(diffText: string): boolean {
    return /^\+.*(maxDiffLines|allowedPaths)/m.test(diffText);
  }
}
