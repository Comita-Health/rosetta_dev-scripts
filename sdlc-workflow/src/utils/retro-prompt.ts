import { ExceptionEntry, GateVerdict } from '../types';

/** Bug-run retro prompt (SPEC-BUG-retro-and-queued-plans-P1 T-01): the spec's Context plus verdict/exception history. */
export const buildRetroPrompt = (
  specId: string,
  context: string,
  verdicts: GateVerdict[],
  exceptions: ExceptionEntry[]
): string =>
  [
    'You are running a post-merge retro on a completed bug-fix run. You have',
    'no context beyond what is below: the bug spec\u2019s own Context section',
    '(the symptom, repro, and root cause an operator already diagnosed) and',
    'every gate verdict and exception-ledger entry this run recorded.',
    '',
    'Answer one question: what would have caught this bug class earlier —',
    'before it needed a dedicated bug-fix run — and which pipeline stage',
    '(e.g. decompose, envelope, reviewer, sandbox, verification, ci, phase,',
    'merge, digest, intake, or a new stage you name) should own that check.',
    '',
    `## Spec ${specId} — Context`,
    '',
    context.length > 0 ? context : '_(no Context section recorded)_',
    '',
    '## Gate verdicts recorded this run',
    '',
    verdicts.length > 0
      ? verdicts
          .map(
            v =>
              `- [${v.taskId ?? 'run'}] ${v.gate}: ${v.outcome}` +
              (v.reasons.length > 0 ? ` — ${v.reasons.join('; ')}` : '')
          )
          .join('\n')
      : '_(no verdicts recorded)_',
    '',
    '## Exception ledger',
    '',
    exceptions.length > 0
      ? exceptions
          .map(
            e =>
              `- [${e.taskId ?? 'run'}] ${e.trigger}: ${e.context.join('; ')}`
          )
          .join('\n')
      : '_(no exceptions recorded)_',
    '',
    'Return one or more stage-attributed recommendations. Each must name a',
    'concrete check (not a vague "be more careful") and briefly justify why',
    'that stage — not another — is the right owner.'
  ].join('\n');
