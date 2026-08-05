import { Envelope, GateVerdict, SpecTask } from '../types';

/**
 * Prompt for the gate remediation agent (Wave 0): dispatched in the task
 * worktree with the red gate verdicts as context, plus every prior round's
 * findings so attempt N+1 can see what attempt N was already told.
 *
 * @remarks
 * The reviewer and envelope gates are advisory *about the diff*, so the
 * remediation contract differs from the CI fix contract in one important
 * way: the agent must never widen the envelope to satisfy the envelope
 * gate. `maxDiffLines` and `forbiddenSurfaces` live in the spec, and the
 * spec tree is a forbidden surface for product tasks — trimming scope is
 * the only in-bounds response to a size breach.
 */
export const buildGateFixPrompt = (
  task: SpecTask,
  envelope: Envelope,
  verdicts: GateVerdict[],
  attempt: number,
  attemptLimit: number,
  priorFindings: string[] = []
): string =>
  [
    `Machine gates rejected the branch implementing task ${task.id}`,
    `(${task.title}). This is remediation attempt ${attempt} of`,
    `${attemptLimit}. Work only inside the current directory — an isolated`,
    'git worktree on the task branch.',
    '',
    '## Task',
    '',
    task.engineeringNotes,
    '',
    '## Acceptance criteria (still binding — do not drop any)',
    '',
    ...task.acceptanceCriteria.map(criterion => `- ${criterion}`),
    '',
    '## Gate findings to address',
    '',
    ...verdicts.flatMap(verdict => [
      `### ${verdict.gate} — ${verdict.outcome}`,
      '',
      ...(verdict.reasons.length > 0
        ? verdict.reasons.map(reason => `- ${reason}`)
        : ['- (no reason recorded)']),
      ''
    ]),
    ...(priorFindings.length > 0
      ? [
          '## Already raised on earlier attempts',
          '',
          'These were the findings you were given before. If any is still',
          'open, that is the priority — do not re-litigate it.',
          '',
          ...priorFindings.map(finding => `- ${finding}`),
          ''
        ]
      : []),
    '## Blast-radius envelope (fixed — the spec owns it, you do not)',
    '',
    `- Allowed paths: ${envelope.allowedPaths.join(', ')}`,
    `- Forbidden surfaces: ${envelope.forbiddenSurfaces.join(', ')}`,
    `- Max diff lines: ${envelope.maxDiffLines} (test files are exempt)`,
    '',
    'If a finding is an envelope breach, respond by TRIMMING the change —',
    'move out-of-scope edits out, split unrelated work, delete incidental',
    'churn. Never edit the spec to raise a limit or relax a surface: that',
    'defeats the gate and the spec tree is off-limits to task diffs.',
    '',
    'If a reviewer finding is factually wrong, say so in the commit body',
    'with evidence rather than making a change you believe is incorrect.',
    '',
    'Fix, verify locally (build and tests), then COMMIT with',
    '`git commit --no-verify -s` (engine branches are `sdlc/*`; husky may',
    'reject them without `--no-verify`). Conventional Commits — use the',
    `task ID as scope, e.g. \`fix(${task.id}): address reviewer findings\`.`,
    'An uncommitted worktree is recorded as a spent attempt. Do not push,',
    'do not open PRs, do not touch anything outside the worktree.'
  ].join('\n');
