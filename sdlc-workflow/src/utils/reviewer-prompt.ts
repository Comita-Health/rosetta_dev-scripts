import { Envelope, SpecTask } from '../types';

/**
 * Build the reviewer-agent prompt (SPEC-PRD-0011-P2 T-05). Independence is
 * structural: the prompt is built from exactly three inputs — the diff, the
 * spec task, and the envelope — never from implementation-agent
 * conversation state.
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
    'Return your verdict: "concur" only if the diff implements the task',
    'within the envelope with no correctness or safety concerns; otherwise',
    '"disagree" with every concern cited as a reason.'
  ].join('\n');
