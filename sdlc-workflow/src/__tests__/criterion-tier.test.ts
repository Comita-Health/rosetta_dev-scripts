import { parseAllCriteria, parseCriterionTier } from '../utils/criterion-tier';
import { RECOGNIZED_TIERS } from '../utils/spec-lint';

describe('parseCriterionTier', () => {
  it('parses each known tier prefix', () => {
    expect(parseCriterionTier('test: runs the suite')).toEqual({
      tier: 'test',
      body: 'runs the suite',
      raw: 'test: runs the suite'
    });
    expect(parseCriterionTier('agent: probes the sandbox').tier).toBe('agent');
    expect(parseCriterionTier('manual: sign-off').tier).toBe('manual');
    expect(parseCriterionTier('docs: README covers the contract').tier).toBe(
      'docs'
    );
  });

  it('accepts every tier the format lint accepts', () => {
    // These two lists drifted over `docs:`: intake passed the lint and then
    // verification threw on the first docs criterion, which also took closeout
    // down when it read the same spec back.
    for (const tier of RECOGNIZED_TIERS) {
      expect(parseCriterionTier(`${tier}: something`).tier).toBe(tier);
    }
  });

  it('rejects a missing prefix', () => {
    expect(() => parseCriterionTier('just some words')).toThrow(
      expect.objectContaining({ code: 'SPEC_MALFORMED' })
    );
  });

  it('rejects an unknown prefix', () => {
    expect(() => parseCriterionTier('e2e: not a tier')).toThrow(
      expect.objectContaining({ code: 'SPEC_MALFORMED' })
    );
  });

  it('parses all criteria up front so validation precedes execution', () => {
    expect(() => parseAllCriteria(['test: fine', 'bogus criterion'])).toThrow();
    expect(parseAllCriteria(['test: a', 'manual: b'])).toHaveLength(2);
  });
});
