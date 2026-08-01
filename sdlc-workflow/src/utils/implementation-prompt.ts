import { SpecDocument, SpecTask } from '../types';

/**
 * Build the implementation-agent prompt for one spec task. The agent works
 * inside an isolated worktree; the envelope is quoted so the agent knows
 * its blast radius even though enforcement is shadow-mode this phase.
 */
export const buildImplementationPrompt = (
  spec: SpecDocument,
  task: SpecTask
): string =>
  [
    `You are implementing task ${task.id} of ${spec.id} (an approved`,
    'implementation spec, ADR-0008). Work only inside the current directory,',
    'which is an isolated git worktree on a dedicated branch. Commit your',
    'work with Conventional Commits and DCO sign-off (git commit -s).',
    'IMPORTANT: repo commit-msg hooks derive a required ticket scope from',
    `the branch name — your commit message MUST use the task ID as scope,`,
    `e.g. \`feat(${task.id}): summary\`. If a commit is rejected by a hook,`,
    'read the hook error and fix the message format — never leave the',
    'worktree uncommitted.',
    '',
    `## Task ${task.id}: ${task.title}`,
    '',
    task.engineeringNotes,
    '',
    '## Acceptance criteria (tier-tagged per ADR-0008)',
    '',
    ...task.acceptanceCriteria.map(c => `- ${c}`),
    '',
    '## Blast-radius envelope (stay within it)',
    '',
    `- Allowed paths: ${spec.envelope.allowedPaths.join(', ')}`,
    `- Forbidden surfaces: ${spec.envelope.forbiddenSurfaces.join(', ')}`,
    `- Max diff lines: ${spec.envelope.maxDiffLines}`,
    '',
    'Implement the task, make every test-tier criterion pass, then COMMIT',
    'your changes (git commit -s, Conventional Commits) before stopping —',
    'an uncommitted worktree is recorded as a failed task. Do not push,',
    'open PRs, or touch anything outside the worktree.'
  ].join('\n');
