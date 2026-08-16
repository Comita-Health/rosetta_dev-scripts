import { buildGateFixPrompt } from '../utils/gate-fix-prompt';
import { buildOperatorUnstickPrompt } from '../utils/operator-unstick-prompt';
import { GateVerdict } from '../types';
import { makeEnvelope, makeTask } from './fixtures';

const verdict = (gate: string, reasons: string[]): GateVerdict => ({
  gate,
  outcome: 'breach',
  wouldEscalate: true,
  reasons,
  recordedAt: 'x'
});

describe('buildOperatorUnstickPrompt (SPEC-PRD-0025-P1 T-02)', () => {
  const prompt = (
    verdicts: GateVerdict[] = [verdict('reviewer', ['stale base'])],
    attempt = 1
  ): string =>
    buildOperatorUnstickPrompt(
      makeTask(),
      makeEnvelope({ maxDiffLines: 400, allowedPaths: ['src/**'] }),
      verdicts,
      attempt,
      2
    );

  it('states an explicit operator mandate for rebase/integration tip, out-of-band merge + record-merge, and resume — not the gate trim-diff contract', () => {
    const text = prompt();

    expect(text).toContain(
      '## Operator mandate (primary — not gate remediation)'
    );
    expect(text).toMatch(/Rebase\s*\/\s*integration tip/i);
    expect(text).toContain('record-merge');
    expect(text).toMatch(/Out-of-band merge/i);
    expect(text).toMatch(/Resume/i);
    expect(text).toContain('--supervise');

    // Must not reuse gate-remediation's primary trim-diff instructions.
    expect(text).not.toContain('respond by TRIMMING the change');
    expect(text).toContain('not trim-the-diff remediation');
    expect(text).toContain('Do not treat this turn as a second gate-fix pass');
  });

  it('instructs abstention (not silent rewrite) for authority-bound and policy acts', () => {
    const text = prompt([verdict('envelope', ['too big'])]);

    expect(text).toContain('abstain');
    expect(text).toContain('Draft→Approved');
    expect(text).toMatch(/Live smoke\s*\/\s*veto/i);
    expect(text).toContain('check-veto');
    expect(text).toContain('PHI');
    expect(text).toContain('maxDiffLines');
    expect(text).toContain('allowedPaths');
    expect(text).toContain('specs/**');
    expect(text).toMatch(/closeout/i);
    expect(text).toContain('never silent policy rewrite');
    expect(text).toContain('will classify those turns as abstained');
    // Risky OUTCOME markers are documented for continue turns, separate
    // from the abstain bullet list — so prompt-echo abstains do not need
    // to restate them next to OUTCOME: abstained.
    expect(text).toContain('OUTCOME: risky-proceed');
    expect(text).toContain('OUTCOME: risky-advisory');
    expect(text).toContain(
      'Mentioning the words in prose, or restating this guidance while'
    );
  });

  it('instructs the OUTCOME: cleared marker the classifier requires for tip clears', () => {
    const text = prompt();

    expect(text).toContain('OUTCOME: cleared');
    expect(text).toContain('OUTCOME: abstained');
    expect(text).toContain('OUTCOME: authority-bound');
    expect(text).toMatch(/Natural-language/);
  });

  it('enumerates exhausted gate findings as context without making them a trim brief', () => {
    const text = prompt([
      verdict('reviewer', ['stale mock']),
      verdict('envelope', ['diff is 900 non-test lines'])
    ]);

    expect(text).toContain('### reviewer — breach');
    expect(text).toContain('- stale mock');
    expect(text).toContain('### envelope — breach');
    expect(text).toContain(
      'Exhausted gate findings (context only — not a trim-diff brief)'
    );
  });

  it('states the unstick attempt budget', () => {
    expect(prompt([verdict('reviewer', ['a'])], 2)).toContain(
      'unstick attempt 2 of'
    );
  });
});

describe('buildGateFixPrompt remains remediator-first (SPEC-PRD-0025-P1 T-02)', () => {
  it('still forbids widening the envelope / editing the Approved spec', () => {
    const text = buildGateFixPrompt(
      makeTask(),
      makeEnvelope({ maxDiffLines: 400 }),
      [verdict('envelope', ['too big'])],
      1,
      2
    );

    expect(text).toContain('TRIMMING the change');
    expect(text).toContain('Never edit the spec to raise a limit');
    expect(text).toContain('Max diff lines: 400');
    expect(text).not.toContain('## Operator mandate');
    expect(text).not.toContain('record-merge');
  });
});
