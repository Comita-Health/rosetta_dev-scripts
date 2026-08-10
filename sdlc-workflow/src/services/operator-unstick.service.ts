import { inject, injectable } from 'inversify';
import type { IRunStateRepository } from '../repositories/run-state.repository';
import { WORKFLOW_TOKENS } from '../tokens';
import {
  Envelope,
  GateVerdict,
  OperatorUnstickOutcome,
  RunState,
  SpecTask
} from '../types';

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
 * SPEC-PRD-0025-P1 T-01 / T-03: result of one operator-unstick turn.
 * Outcome kinds mirror {@link OperatorUnstickOutcome}; `skipped` means the
 * service did not spend an attempt (budget / not wired yet).
 */
export type OperatorUnstickResult =
  | { kind: OperatorUnstickOutcome; attempt: number; detail: string }
  | { kind: 'skipped'; attempt: number; detail: string };

/**
 * Headless operator-unstick after remediable gate remediation exhausts
 * (SPEC-PRD-0025-P1). Distinct from {@link GateRemediationService}: mandate
 * is rebase / integration tip, out-of-band merge + record-merge, and resume
 * — not trim-the-diff remediation.
 *
 * T-01 registers the typed service for DI; T-03 implements dispatch.
 */
export interface IOperatorUnstickService {
  unstick(input: OperatorUnstickInput): Promise<OperatorUnstickResult>;
}

/** Per-task unstick attempt budget; persisted on RunState like gate fixes. */
export const OPERATOR_UNSTICK_ATTEMPT_LIMIT = 2;

@injectable()
export class OperatorUnstickService implements IOperatorUnstickService {
  constructor(
    @inject(WORKFLOW_TOKENS.RunStateRepository)
    private readonly _runStateRepo: IRunStateRepository
  ) {}

  /**
   * Stub: full agent dispatch lands in T-03. Exists so WORKFLOW_TOKENS /
   * index DI can bind the service without inventing a parallel orchestrator.
   */
  async unstick(input: OperatorUnstickInput): Promise<OperatorUnstickResult> {
    const taskId = input.task.id;
    const spent = input.state.operatorUnstickAttempts?.[taskId] ?? 0;
    // Repo is injected for T-03 dispatch (record attempt / outcome / tier).
    if (this._runStateRepo === undefined) {
      throw new Error('RunStateRepository not bound');
    }
    return {
      kind: 'skipped',
      attempt: spent,
      detail: 'operator-unstick dispatch not implemented (T-03)'
    };
  }
}
