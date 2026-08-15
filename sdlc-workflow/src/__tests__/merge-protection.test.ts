import { isHumanReviewRequired } from '../utils/merge-protection';

describe('merge-protection', () => {
  it('detects a human-review branch-protection failure', () => {
    expect(
      isHumanReviewRequired(
        'GraphQL: At least 1 approving review is required'
      )
    ).toBe(true);
    expect(isHumanReviewRequired('CODEOWNERS review required')).toBe(true);
    expect(isHumanReviewRequired('merge conflict in src/a.ts')).toBe(false);
  });
});
