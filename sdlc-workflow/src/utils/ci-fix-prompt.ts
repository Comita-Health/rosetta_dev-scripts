import { SpecTask } from '../types';

/**
 * Prompt for the CI fix agent (P3 T-03): dispatched in the task worktree
 * with the failing check names and their logs as context.
 */
export const buildCiFixPrompt = (
  task: SpecTask,
  failedChecks: string[],
  failedLogs: string,
  attempt: number,
  attemptLimit: number
): string =>
  [
    `CI is failing on the branch implementing task ${task.id}`,
    `(${task.title}). This is fix attempt ${attempt} of ${attemptLimit}.`,
    'Work only inside the current directory — an isolated git worktree on',
    'the task branch.',
    '',
    '## Failing checks',
    '',
    ...failedChecks.map(name => `- ${name}`),
    '',
    '## Failing log output',
    '',
    failedLogs.length > 0 ? failedLogs : '(logs unavailable — rerun locally)',
    '',
    'Diagnose the root cause from the log output, fix it, verify locally',
    '(build and tests), then COMMIT the fix (git commit -s, Conventional',
    'Commits, e.g. fix(scope): correct type error caught by CI) before',
    'stopping. An uncommitted worktree is recorded as a failed attempt.',
    'Do not push, do not open PRs, do not touch anything outside the',
    'worktree.'
  ].join('\n');
