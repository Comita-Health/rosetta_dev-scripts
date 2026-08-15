import { injectable } from 'inversify';
import { ExceptionEntry, GateVerdict, RunState } from '../types';
import { budgetHaltDetail, isBudgetHalt } from '../utils/budget-halt';

export interface GateSet {
  ci: GateVerdict;
  verification: GateVerdict;
  reviewer: GateVerdict;
  envelope: GateVerdict;
  /**
   * Wave 0: sandbox deploy joins the aggregate so a merge implies a
   * deploy. Optional because a repo that declares no sandbox contract
   * produces no sandbox verdict at all — see
   * {@link isDeclaredSandboxFailure} for how "not declared" is kept
   * distinct from "declared and broken".
   */
  sandbox?: GateVerdict;
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
 * SPEC-PRD-0011-P2 T-06: combine the machine gates into one phase-gate
 * verdict and derive exception-ledger entries for every would-escalate
 * trigger (reviewer disagreement, third failing CI fix attempt, envelope
 * breach, sandbox failure, budget exhaustion). Shadow mode: the aggregate
 * verdict is recorded but never advances, blocks, or merges anything —
 * human approval is the only advance mechanism this phase.
 */
export interface IAggregatorService {
  aggregate(input: AggregateInput): AggregateResult;
}

const CI_FIX_ATTEMPT_LIMIT = 3;

/**
 * True when a sandbox verdict represents a *declared* sandbox that failed,
 * as opposed to a repo that never declared one.
 *
 * @remarks
 * `SandboxDeployService` returns `blocked` + `wouldEscalate: false` for the
 * missing-contract case and `breach` + `wouldEscalate: true` for a failed
 * deploy or health check. Folding the former into the aggregate would fail
 * every task in every repo without `.sdlc/environments.json`, so absence
 * stays non-blocking while a real deploy failure now blocks the merge —
 * that asymmetry is the whole point of "merged implies deployed".
 */
const isDeclaredSandboxFailure = (verdict: GateVerdict): boolean =>
  verdict.outcome !== 'pass' && verdict.wouldEscalate === true;

@injectable()
export class AggregatorService implements IAggregatorService {
  aggregate(input: AggregateInput): AggregateResult {
    const now = new Date().toISOString();
    const failing = Object.entries(input.gates)
      .filter(([name, verdict]) => {
        if (verdict === undefined) return false;
        return name === 'sandbox'
          ? isDeclaredSandboxFailure(verdict)
          : verdict.outcome !== 'pass';
      })
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

    if (
      input.gates.sandbox !== undefined &&
      isDeclaredSandboxFailure(input.gates.sandbox)
    ) {
      exceptions.push({
        trigger: 'sandbox-failed',
        taskId: input.taskId,
        context: input.gates.sandbox.reasons,
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

    if (isBudgetHalt(input.state.tokenSpendK, input.budgetK)) {
      exceptions.push({
        trigger: 'budget-exhaustion',
        taskId: input.taskId,
        context: [
          budgetHaltDetail(input.state.tokenSpendK, input.budgetK)
        ],
        recordedAt: now
      });
    }

    return { verdict, exceptions };
  }
}
