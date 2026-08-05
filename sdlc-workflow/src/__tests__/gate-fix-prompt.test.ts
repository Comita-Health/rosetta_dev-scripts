import { buildGateFixPrompt } from '../utils/gate-fix-prompt';
import { GateVerdict } from '../types';
import { makeEnvelope, makeTask } from './fixtures';

const verdict = (gate: string, reasons: string[]): GateVerdict => ({
  gate,
  outcome: 'breach',
  wouldEscalate: true,
  reasons,
  recordedAt: 'x'
});

describe('buildGateFixPrompt (Wave 0)', () => {
  const prompt = (
    verdicts: GateVerdict[],
    attempt = 1,
    prior: string[] = []
  ): string =>
    buildGateFixPrompt(
      makeTask(),
      makeEnvelope({ maxDiffLines: 400 }),
      verdicts,
      attempt,
      2,
      prior
    );

  it('states the attempt budget so the agent knows how many rounds remain', () => {
    expect(prompt([verdict('reviewer', ['a'])], 2)).toContain(
      'remediation attempt 2 of'
    );
  });

  it('enumerates each failing gate with its reasons', () => {
    const text = prompt([
      verdict('reviewer', ['stale mock', 'missing null check']),
      verdict('envelope', ['diff is 900 non-test lines'])
    ]);

    expect(text).toContain('### reviewer — breach');
    expect(text).toContain('- stale mock');
    expect(text).toContain('- missing null check');
    expect(text).toContain('### envelope — breach');
    expect(text).toContain('- diff is 900 non-test lines');
  });

  it('restates the acceptance criteria so a fix cannot quietly drop one', () => {
    expect(prompt([verdict('reviewer', ['a'])])).toContain(
      'test: the thing builds'
    );
  });

  it('forbids widening the envelope as a response to an envelope breach', () => {
    const text = prompt([verdict('envelope', ['too big'])]);

    expect(text).toContain('TRIMMING the change');
    expect(text).toContain('Never edit the spec to raise a limit');
    expect(text).toContain('Max diff lines: 400');
  });

  it('omits the prior-findings section on the first round', () => {
    expect(prompt([verdict('reviewer', ['a'])])).not.toContain(
      'Already raised on earlier attempts'
    );
  });

  it('builds a first-round prompt when prior findings are omitted entirely', () => {
    const text = buildGateFixPrompt(
      makeTask(),
      makeEnvelope(),
      [verdict('reviewer', ['a'])],
      1,
      2
    );

    expect(text).toContain('### reviewer — breach');
    expect(text).not.toContain('Already raised on earlier attempts');
  });

  it('replays prior findings so a later round cannot re-litigate them', () => {
    const text = prompt([verdict('reviewer', ['b'])], 2, ['reviewer: a']);

    expect(text).toContain('Already raised on earlier attempts');
    expect(text).toContain('- reviewer: a');
    expect(text).toContain('do not re-litigate');
  });

  it('handles a verdict with no recorded reason without emitting an empty bullet', () => {
    expect(prompt([verdict('reviewer', [])])).toContain('(no reason recorded)');
  });

  it('requires a no-verify signed commit and forbids pushing', () => {
    const text = prompt([verdict('reviewer', ['a'])]);

    expect(text).toContain('git commit --no-verify -s');
    expect(text).toContain('Do not push');
  });
});
