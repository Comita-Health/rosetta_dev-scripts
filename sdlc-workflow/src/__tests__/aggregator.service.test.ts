import 'reflect-metadata';
import { AggregatorService, GateSet } from '../services/aggregator.service';
import { GateVerdict, RunState } from '../types';

const verdict = (
  gate: string,
  outcome: GateVerdict['outcome'],
  reasons: string[] = []
): GateVerdict => ({
  gate,
  outcome,
  wouldEscalate: outcome !== 'pass',
  reasons,
  recordedAt: 'x'
});

const allGreen = (): GateSet => ({
  ci: verdict('ci', 'pass'),
  verification: verdict('verification', 'pass'),
  reviewer: verdict('reviewer', 'pass'),
  envelope: verdict('envelope', 'pass')
});

const makeState = (overrides: Partial<RunState> = {}): RunState => ({
  runId: 'run-1',
  specId: 'SPEC-PRD-0099-P2',
  specPath: '/specs/spec.md',
  baseSha: 'base',
  taskResults: {},
  verdicts: [],
  exceptions: [],
  criterionVerdicts: [],
  steps: {},
  tokenSpendK: 0,
  ciFixAttempts: {},
  gateFixAttempts: {},
  operatorUnstickAttempts: {},
  operatorUnstickOutcomes: {},
  escalateTiers: {},
  remediations: {},
  mergeBlockedRetries: 0,
  updatedAt: 'x',
  ...overrides
});

const aggregator = new AggregatorService();

const aggregate = (gates: GateSet, state = makeState(), budgetK = 200) =>
  aggregator.aggregate({ gates, state, taskId: 'T-01', budgetK });

/** The missing-contract verdict SandboxDeployService returns verbatim. */
const noSandboxContract = (): GateVerdict => ({
  gate: 'sandbox',
  outcome: 'blocked',
  wouldEscalate: false,
  reasons: [
    'no sandbox contract (.sdlc/environments.json → sandbox) in the repo'
  ],
  recordedAt: 'x'
});

describe('AggregatorService (T-06)', () => {
  it('is green only when all four gates pass', () => {
    const { verdict: phase, exceptions } = aggregate(allGreen());
    expect(phase).toMatchObject({
      gate: 'phase',
      outcome: 'pass',
      wouldEscalate: false,
      reasons: []
    });
    expect(exceptions).toEqual([]);
  });

  it.each(['ci', 'verification', 'reviewer', 'envelope'] as const)(
    'goes red when %s fails, enumerating the failing gate',
    gateName => {
      const gates = allGreen();
      gates[gateName] = verdict(gateName, 'breach', ['why']);

      const { verdict: phase } = aggregate(gates);

      expect(phase.outcome).toBe('breach');
      expect(phase.wouldEscalate).toBe(true);
      expect(phase.reasons[0]).toContain(gateName);
    }
  );

  it('enumerates every failing gate together', () => {
    const gates = allGreen();
    gates.ci = verdict('ci', 'blocked', ['no runs']);
    gates.reviewer = verdict('reviewer', 'breach', ['disagree']);

    const { verdict: phase } = aggregate(gates);
    expect(phase.reasons[0]).toContain('ci');
    expect(phase.reasons[0]).toContain('reviewer');
  });

  it('writes a reviewer-disagreement ledger entry carrying the cited reasons', () => {
    const gates = allGreen();
    gates.reviewer = verdict('reviewer', 'breach', ['unsafe migration']);

    const { exceptions } = aggregate(gates);

    expect(exceptions).toContainEqual(
      expect.objectContaining({
        trigger: 'reviewer-disagreement',
        taskId: 'T-01',
        context: ['unsafe migration']
      })
    );
  });

  it('writes an envelope-breach ledger entry', () => {
    const gates = allGreen();
    gates.envelope = verdict('envelope', 'breach', ['outside allowedPaths']);

    const { exceptions } = aggregate(gates);

    expect(exceptions).toContainEqual(
      expect.objectContaining({
        trigger: 'envelope-breach',
        context: ['outside allowedPaths']
      })
    );
  });

  it('writes a ci-fix-attempts ledger entry with attempt history at the third attempt', () => {
    const state = makeState({ ciFixAttempts: { 'T-01': 3 } });

    const { exceptions } = aggregate(allGreen(), state);

    expect(exceptions).toContainEqual(
      expect.objectContaining({
        trigger: 'ci-fix-attempts-exhausted',
        context: ['3 failing CI fix attempts (limit 3)']
      })
    );
  });

  it('writes a budget-exhaustion ledger entry when spend exceeds the budget', () => {
    const state = makeState({ tokenSpendK: 250 });

    const { exceptions } = aggregate(allGreen(), state, 200);

    expect(exceptions).toContainEqual(
      expect.objectContaining({
        trigger: 'budget-exhaustion',
        context: ['token spend 250k exceeds budget 200k']
      })
    );
  });

  it('stays quiet below the exception thresholds', () => {
    const state = makeState({
      ciFixAttempts: { 'T-01': 2 },
      tokenSpendK: 199
    });

    const { exceptions } = aggregate(allGreen(), state, 200);
    expect(exceptions).toEqual([]);
  });

  // Wave 0: the sandbox verdict was computed but never handed to the
  // aggregator, so a failed deploy did not block a merge — "it merged" never
  // meant "it deployed".
  describe('sandbox gate (Wave 0)', () => {
    it('blocks the phase when a declared sandbox fails to deploy', () => {
      const gates = allGreen();
      gates.sandbox = verdict('sandbox', 'breach', ['deploy command failed']);

      const { verdict: phase, exceptions } = aggregate(gates);

      expect(phase.outcome).toBe('breach');
      expect(phase.reasons[0]).toContain('sandbox');
      expect(exceptions).toContainEqual(
        expect.objectContaining({
          trigger: 'sandbox-failed',
          taskId: 'T-01',
          context: ['deploy command failed']
        })
      );
    });

    it('passes when a declared sandbox deploys healthy', () => {
      const gates = allGreen();
      gates.sandbox = verdict('sandbox', 'pass', ['deployed and healthy']);

      const { verdict: phase, exceptions } = aggregate(gates);

      expect(phase.outcome).toBe('pass');
      expect(exceptions).toEqual([]);
    });

    // Graceful degradation is the whole reason this gate is not a plain
    // `outcome !== 'pass'` check: a repo with no `.sdlc/environments.json`
    // reports `blocked`, and failing every task in every such repo would
    // make the engine unusable outside repos that already have a sandbox.
    it('does not block a repo that declares no sandbox contract', () => {
      const gates = allGreen();
      gates.sandbox = noSandboxContract();

      const { verdict: phase, exceptions } = aggregate(gates);

      expect(phase.outcome).toBe('pass');
      expect(phase.reasons).toEqual([]);
      expect(exceptions).toEqual([]);
    });

    it('is optional — an absent sandbox verdict changes nothing', () => {
      const { verdict: phase } = aggregate(allGreen());
      expect(phase.outcome).toBe('pass');
    });

    // The caller passes `sandbox: sandboxOutcome?.verdict`, so the key is
    // present and explicitly undefined whenever the sandbox step was skipped.
    it('treats an explicitly undefined sandbox the same as an absent one', () => {
      const { verdict: phase, exceptions } = aggregate({
        ...allGreen(),
        sandbox: undefined
      });

      expect(phase.outcome).toBe('pass');
      expect(exceptions).toEqual([]);
    });
  });
});
