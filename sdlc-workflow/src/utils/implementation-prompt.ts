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
    'work with Conventional Commits and DCO sign-off',
    '(`git commit --no-verify -s`). Engine branches are `sdlc/<run>/<task>`',
    '— many target repos only allow `f/*` / `b/*` in husky pre-commit, so',
    '`--no-verify` is required for the commit to land. IMPORTANT: commit-msg',
    'hooks (when not skipped) derive a required ticket scope from the',
    `branch name — your commit message MUST use the task ID as scope,`,
    `e.g. \`feat(${task.id}): summary\`. If a commit is rejected, fix the`,
    'message or retry with `--no-verify -s` — never leave the worktree',
    'uncommitted (the engine will salvage-commit a dirty tree on exit).',
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
    'HARD RULE — do not modify anything under `specs/**` (or `**/specs/**`):',
    'do not flip acceptance-criteria checkboxes, do not change `status:`,',
    'and do not edit the Approved spec file. Phase Done / checkbox closeout',
    'is a separate docs PR after the product tasks merge.',
    '',
    'HARD RULE — never reformat lines you did not author. When appending to',
    'shared ledger files (CHANGELOG.md, records tables, READMEs), match the',
    'existing style byte-for-byte and do not run a formatter over the whole',
    'file: formatter rewrites of historical entries (`*`→`_`, list markers,',
    'indentation) are reviewer-gate breaches. Scope formatting to files you',
    'created or substantially own.',
    '',
    'Implement the task, make every test-tier criterion pass, then COMMIT',
    'your changes (git commit -s, Conventional Commits) before stopping —',
    'an uncommitted worktree is recorded as a failed task. Do not push,',
    'open PRs, or touch anything outside the worktree.'
  ].join('\n');
