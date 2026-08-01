import { inject, injectable } from 'inversify';
import type { ICiStatusRepository } from '../repositories/ci-status.repository';
import { WORKFLOW_TOKENS } from '../tokens';
import { GateVerdict } from '../types';
import { inputsDigest } from '../utils/digest';

export interface CiGateInput {
  repoPath: string;
  sha: string;
  taskId: string;
}

/**
 * The real CI gate: queries GitHub check runs for the task branch's head
 * SHA. Shadow-mode honesty rules:
 * - commit unknown to the remote (task branches are not pushed this phase)
 *   → blocked, with the reason spelled out;
 * - no check runs reported, or runs still pending → blocked;
 * - any failed run → breach (would escalate);
 * - all runs green → pass.
 */
export interface ICiGateService {
  evaluate(input: CiGateInput): Promise<GateVerdict>;
}

@injectable()
export class CiGateService implements ICiGateService {
  constructor(
    @inject(WORKFLOW_TOKENS.CiStatusRepository)
    private readonly _ciStatusRepo: ICiStatusRepository
  ) {}

  async evaluate(input: CiGateInput): Promise<GateVerdict> {
    const digest = inputsDigest({ gate: 'ci', sha: input.sha });
    const base = {
      gate: 'ci',
      taskId: input.taskId,
      inputsDigest: digest,
      recordedAt: new Date().toISOString()
    };

    const summary = this._ciStatusRepo.checkRuns(input.repoPath, input.sha);
    if (summary === null) {
      return {
        ...base,
        outcome: 'blocked',
        wouldEscalate: false,
        reasons: [
          `no CI results for ${input.sha} — task branch not pushed (shadow mode) or gh unavailable`
        ]
      };
    }
    if (summary.total === 0) {
      return {
        ...base,
        outcome: 'blocked',
        wouldEscalate: false,
        reasons: [`commit ${input.sha} has no check runs`]
      };
    }
    if (summary.failed.length > 0) {
      return {
        ...base,
        outcome: 'breach',
        wouldEscalate: true,
        reasons: summary.failed.map(name => `check failed: ${name}`)
      };
    }
    if (summary.pending.length > 0) {
      return {
        ...base,
        outcome: 'blocked',
        wouldEscalate: false,
        reasons: summary.pending.map(name => `check pending: ${name}`)
      };
    }
    return {
      ...base,
      outcome: 'pass',
      wouldEscalate: false,
      reasons: [`${summary.total} check runs green for ${input.sha}`]
    };
  }
}
