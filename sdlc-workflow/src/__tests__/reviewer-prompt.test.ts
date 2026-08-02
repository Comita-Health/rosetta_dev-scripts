import { buildReviewerPrompt } from '../utils/reviewer-prompt';
import { makeEnvelope, makeTask } from './fixtures';

describe('buildReviewerPrompt', () => {
  it('includes the documentation bar checklist for HSR and frontend surfaces', () => {
    const prompt = buildReviewerPrompt(
      makeTask(),
      makeEnvelope(),
      'diff --git a/src/a.ts b/src/a.ts\n+added line'
    );

    expect(prompt).toContain('## Documentation bar (TSDoc / JSDoc)');
    expect(prompt).toContain('@injectable()');
    expect(prompt).toContain('non-obvious platform/auth/session/entitlement');
    expect(prompt).toContain('documentation-bar');
  });
});
