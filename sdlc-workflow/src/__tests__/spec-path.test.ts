import { isSpecTreePath } from '../utils/spec-path';

/**
 * SPEC-PRD-0023-P1 T-06: the envelope gate (which forbids `specs/**` in an
 * agent diff) and the closeout writer (the one exception to that rule) must
 * agree on what counts as a spec path. If they drift, either closeout starts
 * breaching its own gate or an agent finds a spec path the gate does not see.
 */
describe('isSpecTreePath (shared specs/** definition)', () => {
  it.each([
    'specs/PRD-0023/phase-1-spec.md',
    'specs/BUG-reviewer-house-bar/phase-1-spec.md',
    'packages/engine/specs/PRD-0001/phase-1-spec.md',
    'rosetta_dev-scripts/specs/PRD-0011/phase-4-spec.md'
  ])('treats %s as a spec path', filePath => {
    expect(isSpecTreePath(filePath)).toBe(true);
  });

  it.each([
    'src/services/closeout.service.ts',
    'docs/specs.md',
    'README.md',
    'specs.md',
    'myspecs/PRD-0023/phase-1-spec.md'
  ])('does not treat %s as a spec path', filePath => {
    expect(isSpecTreePath(filePath)).toBe(false);
  });
});
