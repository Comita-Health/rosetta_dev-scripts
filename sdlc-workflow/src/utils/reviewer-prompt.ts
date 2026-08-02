import { Envelope, SpecTask } from '../types';

/**
 * Build the reviewer-agent prompt (SPEC-PRD-0011-P2 T-05). Independence is
 * structural: the prompt is built from exactly three inputs — the diff, the
 * spec task, and the envelope — never from implementation-agent
 * conversation state.
 *
 * Includes the workspace documentation bar (TSDoc/JSDoc) so reviews catch
 * missing or hollow docs on new HSR classes and non-obvious helpers.
 */
export const buildReviewerPrompt = (
  task: SpecTask,
  envelope: Envelope,
  diff: string
): string =>
  [
    'You are an independent code reviewer. You have no context beyond what',
    'is below: one spec task, its blast-radius envelope, and the diff of the',
    'branch that claims to implement it. Decide whether you concur that the',
    'diff correctly and safely implements the task.',
    '',
    `## Task ${task.id}: ${task.title}`,
    '',
    task.engineeringNotes,
    '',
    '### Acceptance criteria',
    '',
    ...task.acceptanceCriteria.map(c => `- ${c}`),
    '',
    '## Blast-radius envelope',
    '',
    `- Allowed paths: ${envelope.allowedPaths.join(', ')}`,
    `- Forbidden surfaces: ${envelope.forbiddenSurfaces.join(', ')}`,
    `- Max diff lines: ${envelope.maxDiffLines}`,
    '',
    '## Diff',
    '',
    '```diff',
    diff,
    '```',
    '',
    '## Documentation bar (TSDoc / JSDoc)',
    '',
    'Treat useful inline docs as part of correctness for new or substantially',
    'changed exports — same bar as a missing test when the surface warrants it.',
    '',
    '- Backend / engine: new `@injectable()` Handler, Service, or Repository',
    '  classes and their new public methods need TSDoc covering purpose and',
    '  non-obvious invariants (authz, PHI/PII, idempotency, failure modes).',
    '  Do not require `@param` / `@returns` that only restate TypeScript types.',
    '- Frontend: types/props are the primary API docs; require short TSDoc on',
    '  non-obvious platform/auth/session/entitlement helpers. Do not fail solely',
    '  for missing prop JSDoc on presentational components when types are clear.',
    '- Disagree on placeholder noise (`/** Service */`) or missing docs on a new',
    '  HSR class / non-obvious public helper introduced in the diff.',
    '',
    'Return your verdict: "concur" only if the diff implements the task',
    'within the envelope with no correctness, safety, or documentation-bar',
    'concerns; otherwise "disagree" with every concern cited as a reason.'
  ].join('\n');
