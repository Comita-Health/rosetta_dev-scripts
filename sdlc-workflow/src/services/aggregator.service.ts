import { injectable } from 'inversify';
import { ExceptionEntry, GateVerdict, RunState } from '../types';

export interface GateSet {
  ci: GateVerdict;
  verification: GateVerdict;
  reviewer: GateVerdict;
  envelope: GateVerdict;
}

export interface AggregateInput {
  gates: GateSet;
  state: RunState;
  taskId: string;
  budgetK: number;
}

export interface AggregateResult {
  verdict: GateVerdict;
  exceptions: ExceptionEntry[];
}

/**
 * SPEC-PRD-0011-P2 T-06: combine the four machine gates into one
 * phase-gate verdict and derive exception-ledger entries for every
 * would-escalate trigger (reviewer disagreement, third failing CI fix
 * attempt, envelope breach, budget exhaustion). Shadow mode: the aggregate
 * verdict is recorded but never advances, blocks, or merges anything —
 * human approval is the only advance mechanism this phase.
 */
export interface IAggregatorService {
  aggregate(input: AggregateInput): AggregateResult;
}

const CI_FIX_ATTEMPT_LIMIT = 3;

@injectable()
export class AggregatorService implements IAggregatorService {
  aggregate(input: AggregateInput): AggregateResult {
    const now = new Date().toISOString();
    const failing = Object.entries(input.gates)
      .filter(([, verdict]) => verdict.outcome !== 'pass')
      .map(([name]) => name);

    const verdict: GateVerdict = {
      gate: 'phase',
      outcome: failing.length === 0 ? 'pass' : 'breach',
      wouldEscalate: failing.length > 0,
      reasons:
        failing.length === 0 ? [] : [`failing gates: ${failing.join(', ')}`],
      recordedAt: now
    };

    const exceptions: ExceptionEntry[] = [];

    if (input.gates.reviewer.outcome !== 'pass') {
      exceptions.push({
        trigger: 'reviewer-disagreement',
        taskId: input.taskId,
        context: input.gates.reviewer.reasons,
        recordedAt: now
      });
    }

    if (input.gates.envelope.outcome === 'breach') {
      exceptions.push({
        trigger: 'envelope-breach',
        taskId: input.taskId,
        context: input.gates.envelope.reasons,
        recordedAt: now
      });
    }

    const attempts = input.state.ciFixAttempts[input.taskId] ?? 0;
    if (attempts >= CI_FIX_ATTEMPT_LIMIT) {
      exceptions.push({
        trigger: 'ci-fix-attempts-exhausted',
        taskId: input.taskId,
        context: [
          `${attempts} failing CI fix attempts (limit ${CI_FIX_ATTEMPT_LIMIT})`
        ],
        recordedAt: now
      });
    }

    if (input.state.tokenSpendK > input.budgetK) {
      exceptions.push({
        trigger: 'budget-exhaustion',
        taskId: input.taskId,
        context: [
          `token spend ${input.state.tokenSpendK}k exceeds budget ${input.budgetK}k`
        ],
        recordedAt: now
      });
    }

    return { verdict, exceptions };
  }
}
