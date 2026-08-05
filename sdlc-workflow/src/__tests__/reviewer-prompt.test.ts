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
    expect(prompt).toContain('HARD RULE');
    expect(prompt).toContain('specs/**');
  });

  // BUG-retro-and-queued-plans-P1 retro: the reviewer's own size judgment
  // must match the mechanical envelope gate's test-exempt maxDiffLines.
  it('tells the reviewer that maxDiffLines exempts test files', () => {
    const prompt = buildReviewerPrompt(
      makeTask(),
      makeEnvelope(),
      'diff --git a/src/a.ts b/src/a.ts\n+added line'
    );

    expect(prompt).toContain('test files');
    expect(prompt).toContain('exempt from this budget');
    expect(prompt).toContain('__tests__/**');
  });

  // T-01 no-regression: omitting the checklist reproduces the pre-checklist
  // prompt byte-for-byte.
  it('is byte-identical with no checklist argument', () => {
    const args = [
      makeTask(),
      makeEnvelope(),
      'diff --git a/src/a.ts b/src/a.ts\n+added line'
    ] as const;

    expect(buildReviewerPrompt(...args)).toBe(
      buildReviewerPrompt(...args, undefined)
    );
    expect(buildReviewerPrompt(...args)).not.toContain('Repo review checklist');
  });

  it('includes checklist items and finding instructions when a checklist is present', () => {
    const prompt = buildReviewerPrompt(
      makeTask(),
      makeEnvelope(),
      'diff --git a/src/a.ts b/src/a.ts\n+added line',
      {
        items: [
          { text: 'Every new HSR class has TSDoc', mandatory: true },
          { text: 'Prefer readability over cleverness', mandatory: false }
        ]
      }
    );

    expect(prompt).toContain('## Repo review checklist');
    expect(prompt).toContain('1. Every new HSR class has TSDoc (mandatory)');
    expect(prompt).toContain('2. Prefer readability over cleverness');
    expect(prompt).not.toContain(
      'Prefer readability over cleverness (mandatory)'
    );
    expect(prompt).toContain('checklistFindings');
    expect(prompt).toContain('itemIndex');
  });
});
