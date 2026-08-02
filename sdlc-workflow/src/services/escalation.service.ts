import { inject, injectable } from 'inversify';
import type { IGitHubIssueRepository } from '../repositories/github-issue.repository';
import type { IQueueRepository } from '../repositories/queue.repository';
import { WORKFLOW_TOKENS } from '../tokens';
import { ExceptionEntry, ExceptionTrigger } from '../types';
import { evidenceLink } from './digest.service';

export interface EscalateInput {
  /** Absent → queue items are skipped (no Chronicle, nothing to append to). */
  chronicleRepo?: string;
  /** Absent → GitHub issues are skipped (no target repo to file against). */
  repoPath?: string;
  runId: string;
  entries: ExceptionEntry[];
  /** Evidence IDs recorded for the task — linked in the queue item. */
  evidenceIds?: string[];
}

export interface EscalateOutcome {
  /** Titles of items actually appended (already-present titles excluded). */
  posted: string[];
  /** URLs of the needs-human GitHub issues filed or refreshed. */
  issueUrls: string[];
}

/**
 * SPEC-PRD-0011-P3 T-06: turn exception-ledger entries into interrupting
 * action-required items. Each trigger posts one Chronicle queue item and one
 * `needs-human` GitHub issue naming the task, the trigger, and the evidence
 * refs — and the affected task is halted by staying unmerged (T-01 / T-04),
 * so only that task stops.
 *
 * Both surfaces are idempotent: resume refreshes rather than duplicates.
 */
export interface IEscalationService {
  post(input: EscalateInput): EscalateOutcome;
}

export const escalationTitle = (runId: string, entry: ExceptionEntry): string =>
  `ACTION REQUIRED: SDLC ${runId} ${entry.taskId} — ${entry.trigger}`;

export const NEEDS_HUMAN_LABEL = 'needs-human';

/** Stable per-run/task/trigger key backing GitHub issue idempotency. */
export const escalationKey = (runId: string, entry: ExceptionEntry): string =>
  `${runId}/${entry.taskId ?? 'run'}/${entry.trigger}`;

/**
 * What the human actually has to do, per trigger. Without this the issue
 * says only that something is wrong, which is the state the loop was already
 * in — the point of the surface is that it carries the next action.
 */
const remedy = (trigger: ExceptionTrigger, runId: string): string => {
  const resume = `bunx tsx src/index.ts run --run-id ${runId} --supervise --detach ...`;
  switch (trigger) {
    case 'reviewer-disagreement':
      return `Read the reviewer transcript below. If the reviewer is right, fix the code on the task branch. If it is a false positive, note why on the PR. Then resume:\n\n    ${resume}`;
    case 'envelope-breach':
      return `The diff touched a path outside the spec envelope. Either revert that file, or amend \`envelope.allowedPaths\` in the spec — which resets the spec to \`Draft\` and needs re-approval (ADR-0008). Then resume:\n\n    ${resume}`;
    case 'ci-fix-attempts-exhausted':
      return `The engine tried three CI fixes and stopped. Fix CI by hand on the task branch, then resume:\n\n    ${resume}`;
    case 'budget-exhaustion':
      return `Token spend passed the spec budget. Raise \`envelope.budgetK\` (re-approval required) or narrow the task, then resume:\n\n    ${resume}`;
    case 'merge-blocked':
      return `Every gate must be green before the engine merges. Clear the red gate listed below, then resume:\n\n    ${resume}`;
    case 'manual-criterion':
      return `This task has a \`manual:\` acceptance criterion, which is a deliberate opt-out of the evidence gate. Verify it yourself, then either retag it \`agent:\`/\`test:\` in the spec or merge the PR by hand and record it:\n\n    bunx tsx src/index.ts record-merge --run-id ${runId} --task <task> --sha <sha> ...`;
    case 'no-commit':
      return `The implementation agent finished without committing anything. Re-read the task wording — if it is ambiguous, edit the spec (which changes the content digest and makes the task eligible again), then resume:\n\n    ${resume}`;
    case 'agent-timeout':
      return `The agent exceeded its wall-clock budget and was killed. Check the transcript for a loop, then resume:\n\n    ${resume}`;
    case 'pr-open-failed':
      return `Push or \`gh pr create\` failed, so downstream gates had no PR. Usually a \`gh\` identity problem — re-activate the workspace GitHub App, then resume:\n\n    ${resume}`;
    case 'supervisor-died':
      return `The detached supervisor exited with the run incomplete. The continuity daemon relaunches it automatically; if it keeps dying, read \`supervise.log\` for the cause.`;
    case 'phase-blocked-on-unmerged':
      return `The phase boundary cannot deploy until every task is merged. Merge the remaining task PRs (or clear their gates), then resume:\n\n    ${resume}`;
    default:
      return `Resume once the blocker is cleared:\n\n    ${resume}`;
  }
};

const issueBody = (
  runId: string,
  entry: ExceptionEntry,
  evidenceIds: string[]
): string => {
  const lines = [
    `**Run:** \`${runId}\``,
    `**Task:** \`${entry.taskId ?? 'run-level'}\``,
    `**Trigger:** \`${entry.trigger}\``,
    `**Recorded:** ${entry.recordedAt}`,
    '',
    '## Why the loop stopped',
    ''
  ];
  lines.push(
    ...(entry.context.length > 0
      ? entry.context.map(reason => `- ${reason}`)
      : ['- (no additional context recorded)'])
  );
  lines.push('', '## What to do', '', remedy(entry.trigger, runId));
  if (evidenceIds.length > 0) {
    lines.push('', '## Evidence', '');
    lines.push(...evidenceIds.map(id => `- \`${evidenceLink(runId, id)}\``));
  }
  lines.push(
    '',
    '---',
    '',
    '_Filed by the SDLC engine. **Close this issue to signal the blocker is cleared** — the continuity daemon treats a close as the resume signal._'
  );
  return lines.join('\n');
};

@injectable()
export class EscalationService implements IEscalationService {
  constructor(
    @inject(WORKFLOW_TOKENS.QueueRepository)
    private readonly _queueRepo: IQueueRepository,
    @inject(WORKFLOW_TOKENS.GitHubIssueRepository)
    private readonly _issueRepo: IGitHubIssueRepository
  ) {}

  post(input: EscalateInput): EscalateOutcome {
    if (input.entries.length === 0) {
      return { posted: [], issueUrls: [] };
    }

    const posted: string[] = [];
    const issueUrls: string[] = [];
    const evidenceIds = input.evidenceIds ?? [];

    for (const entry of input.entries) {
      const title = escalationTitle(input.runId, entry);

      if (input.chronicleRepo !== undefined) {
        const tags = [
          'action-required',
          `trigger:${entry.trigger}`,
          `task:${entry.taskId}`,
          ...entry.context.slice(0, 2).map(c => `ctx:${c.slice(0, 80)}`),
          ...evidenceIds.map(id => `evidence:${evidenceLink(input.runId, id)}`)
        ];
        if (this._queueRepo.appendItem(input.chronicleRepo, title, tags)) {
          posted.push(title);
        }
      }

      if (input.repoPath !== undefined) {
        // A GitHub outage must not lose the escalation — the queue item and
        // the halted task already record it, so this surface is best-effort.
        try {
          const ref = this._issueRepo.upsert({
            repoPath: input.repoPath,
            key: escalationKey(input.runId, entry),
            title,
            body: issueBody(input.runId, entry, evidenceIds),
            labels: [
              NEEDS_HUMAN_LABEL,
              `sdlc-run:${input.runId}`,
              `trigger:${entry.trigger}`,
              ...(entry.taskId === undefined ? [] : [`task:${entry.taskId}`])
            ]
          });
          issueUrls.push(ref.url);
        } catch {
          // Swallowed by design; see above.
        }
      }
    }

    return { posted, issueUrls };
  }
}
