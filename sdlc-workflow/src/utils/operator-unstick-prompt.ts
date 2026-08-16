import { Envelope, GateVerdict, SpecTask } from '../types';

/**
 * Prompt for the headless operator-unstick agent (SPEC-PRD-0025-P1 T-02):
 * dispatched after remediable gate remediation exhausts, on the local
 * supervise/daemon path with no chat/session object.
 *
 * @remarks
 * This is intentionally **not** {@link buildGateFixPrompt}. Gate remediation
 * stays remediator-first and trim-the-diff; unstick's mandate is routine
 * operator integration work via existing engine CLIs (rebase / integration
 * tip, out-of-band merge + `record-merge`, resume). Authority-bound and
 * policy-rewrite acts must abstain — never silently rewrite Approved policy.
 * Non-policy risky proceeds use an explicit `OUTCOME:` marker; the engine
 * alone promotes that to a continue+advisory path.
 */
export const buildOperatorUnstickPrompt = (
  task: SpecTask,
  envelope: Envelope,
  verdicts: GateVerdict[],
  attempt: number,
  attemptLimit: number
): string =>
  [
    `Operator-unstick for task ${task.id} (${task.title}). Remediable gate`,
    `remediation has exhausted; this is unstick attempt ${attempt} of`,
    `${attemptLimit}. Work only inside the current directory — an isolated`,
    'git worktree on the task branch. There is no chat/session dispatcher;',
    'act through existing engine CLIs and git on this worktree.',
    '',
    '## Operator mandate (primary — not gate remediation)',
    '',
    'Your job is routine operator unstick, not trim-the-diff remediation.',
    'Do not treat this turn as a second gate-fix pass: do not adopt the',
    'gate-remediation contract of TRIMMING the change to satisfy envelope',
    'size, and do not re-litigate reviewer findings by rewriting product',
    'code as your primary path. Prefer the following, in order:',
    '',
    '1. **Rebase / integration tip** — refresh the task branch onto the',
    '   current integration tip (post-merge base from dependencies or the',
    '   default branch) so the stuck head can clear merge/integration drift.',
    '2. **Out-of-band merge + `record-merge`** — if the task PR already',
    '   landed (or lands) outside the engine, record it with the existing',
    '   `record-merge` CLI (`--run-id`, `--sha`, `--task`, chronicle repo)',
    '   rather than inventing a parallel merge bookkeeping path.',
    '3. **Resume** — after the blocker is cleared, resume the run via the',
    '   existing engine CLIs (`run` with `--supervise` / daemon resume from',
    '   `launch.json`). Do not invent a new orchestrator.',
    '',
    'On a successful clear, leave durable evidence the engine can classify',
    '(blocker gone; merge recorded via `record-merge`, and/or a successful',
    'rebase/integration tip HEAD move) **and** end your reply with an',
    'explicit marker line the classifier matches:',
    '',
    '  OUTCOME: cleared',
    '',
    'Use the same `OUTCOME: <kind>` form when you cannot clear safely',
    '(`OUTCOME: abstained`, `OUTCOME: authority-bound`). Natural-language',
    '“cleared” alone is not enough — without the marker a successful tip',
    'rebase will not suppress ACTION REQUIRED. If you cannot clear safely,',
    'abstain so the engine can file ACTION REQUIRED.',
    '',
    'When you **do** continue under a named non-policy risk (not an',
    'Approved-artifact edit), end with exactly one of:',
    '',
    '  OUTCOME: risky-proceed',
    '  OUTCOME: risky-advisory',
    '',
    'The engine alone promotes those markers to a continue+advisory path.',
    'Mentioning the words in prose, or restating this guidance while',
    'abstaining, is not a proceed — write `OUTCOME: abstained` instead.',
    '',
    '## Task context',
    '',
    task.engineeringNotes,
    '',
    '## Exhausted gate findings (context only — not a trim-diff brief)',
    '',
    ...verdicts.flatMap(verdict => [
      `### ${verdict.gate} — ${verdict.outcome}`,
      '',
      ...(verdict.reasons.length > 0
        ? verdict.reasons.map(reason => `- ${reason}`)
        : ['- (no reason recorded)']),
      ''
    ]),
    '## Blast-radius envelope (informational — you do not own it)',
    '',
    `- Allowed paths: ${envelope.allowedPaths.join(', ')}`,
    `- Forbidden surfaces: ${envelope.forbiddenSurfaces.join(', ')}`,
    `- Max diff lines: ${envelope.maxDiffLines}`,
    '',
    '## Authority-bound and policy acts — abstain (no silent rewrite)',
    '',
    'If clearing the stick would require any of the following, **abstain**',
    '(write `OUTCOME: abstained` or `OUTCOME: authority-bound`) rather than',
    'rewriting policy or forging authority. Do not silently flip, waive, or',
    'widen. Editing Approved artifacts (`specs/**`, envelope limits) is never',
    'a proceed — the engine will classify those turns as abstained even if',
    'you claim a risky OUTCOME marker. You must not self-authorize by',
    'editing Approved artifacts.',
    '',
    '- **Draft→Approved flips** — never change spec `status:` from Draft to',
    '  Approved (or otherwise approve a spec mid-run). Abstain.',
    '- **Live smoke / veto waivers** — never waive live smoke, `check-veto`,',
    '  or related deploy/veto gates. Abstain.',
    '- **PHI handling** — never handle, relocate, or “fix around” PHI.',
    '  Abstain for human/ACTION REQUIRED.',
    '- **Raising `maxDiffLines` / `allowedPaths`** — never edit the Approved',
    '  envelope to raise limits or expand surfaces. Abstain — never silent policy rewrite.',
    '- **Mid-run `specs/**` closeout edits** — never flip acceptance-criteria',
    '  checkboxes, change `status:`, or otherwise close out the Approved',
    '  spec mid-run. Phase Done / checkbox closeout is a separate docs PR.',
    '  Abstain.',
    '',
    'When you abstain, say so clearly with the authority-bound or policy',
    'reason; do not pretend the wave cleared. Do not push a forged “fix”',
    'that only edits the Approved spec or envelope to silence a gate.'
  ].join('\n');
