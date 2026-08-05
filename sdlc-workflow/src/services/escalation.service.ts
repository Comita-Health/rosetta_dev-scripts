import { appendFileSync, mkdirSync } from 'fs';
import { inject, injectable } from 'inversify';
import path from 'path';
import type { IIssueRepository } from '../repositories/issue.repository';
import type { IQueueRepository } from '../repositories/queue.repository';
import type { IWakeInboxRepository } from '../repositories/wake-inbox.repository';
import { WORKFLOW_TOKENS } from '../tokens';
import { ExceptionEntry, WorkflowError } from '../types';
import { evidenceLink } from './digest.service';

export interface EscalateInput {
  /** Absent → queue items are skipped (no Chronicle, nothing to append to). */
  chronicleRepo?: string;
  runId: string;
  entries: ExceptionEntry[];
  /** Evidence IDs recorded for the task — linked in the queue item. */
  evidenceIds?: string[];
  /** Target repo checkout for `gh issue create`. Absent → skip GitHub half. */
  repoPath?: string;
  /**
   * GitHub login assigned on needs-human issues. Absent → issues still post
   * unassigned and a loud monitor.log warning is appended (no hardcoded
   * usernames in engine code).
   */
  operator?: string;
  /** Path for loud escalation warnings (default: skip file write). */
  monitorPath?: string;
  /**
   * Identifies the content this escalation is about — normally the task's
   * head SHA or the failing verdict's inputs digest. Resuming a run passes
   * the same value and stays quiet; the same escalation recurring against
   * *new* content passes a different value and wakes the human again.
   * Absent → once-ever per title, the pre-Wave-0 behaviour.
   */
  occurrenceKey?: string;
  /** Override wake-inbox root for tests. */
  wakeDir?: string;
}

export interface EscalateOutcome {
  /** Titles of items newly delivered (queue and/or issue); already-present excluded. */
  posted: string[];
  /** Titles for which a wake was newly emitted. */
  wakes: string[];
  /** Issue URLs created or reused this call (title → url). */
  issues: Record<string, string>;
}

/**
 * SPEC-PRD-0011-P3 T-06 + fail-loud T-04: turn exception-ledger entries into
 * interrupting action-required queue items, assigned needs-human GitHub
 * issues, and durable wake-inbox events. Idempotent by title: resume never
 * duplicates a queue item, issue, or wake.
 */
export interface IEscalationService {
  post(input: EscalateInput): EscalateOutcome;
}

export const escalationTitle = (runId: string, entry: ExceptionEntry): string =>
  `ACTION REQUIRED: SDLC ${runId} ${entry.taskId} — ${entry.trigger}`;

const escalationBody = (
  runId: string,
  entry: ExceptionEntry,
  evidenceIds: string[] | undefined
): string => {
  const evidence =
    evidenceIds === undefined || evidenceIds.length === 0
      ? '_none_'
      : evidenceIds.map(id => `- \`${evidenceLink(runId, id)}\``).join('\n');
  return [
    `SDLC run \`${runId}\` needs human attention.`,
    '',
    `- **Task:** ${entry.taskId ?? '(run-level)'}`,
    `- **Trigger:** ${entry.trigger}`,
    '',
    '### Context',
    ...(entry.context.length > 0
      ? entry.context.map(line => `- ${line}`)
      : ['- _(empty)_']),
    '',
    '### Evidence',
    evidence,
    '',
    '_Filed by sdlc-workflow escalation (fail-loud T-04)._'
  ].join('\n');
};

const appendMonitor = (monitorPath: string | undefined, line: string): void => {
  if (monitorPath === undefined || monitorPath.length === 0) {
    return;
  }
  mkdirSync(path.dirname(monitorPath), { recursive: true });
  appendFileSync(monitorPath, `${line}\n`);
};

@injectable()
export class EscalationService implements IEscalationService {
  constructor(
    @inject(WORKFLOW_TOKENS.QueueRepository)
    private readonly _queueRepo: IQueueRepository,
    @inject(WORKFLOW_TOKENS.IssueRepository)
    private readonly _issueRepo: IIssueRepository,
    @inject(WORKFLOW_TOKENS.WakeInboxRepository)
    private readonly _wakeRepo: IWakeInboxRepository
  ) {}

  post(input: EscalateInput): EscalateOutcome {
    if (input.entries.length === 0) {
      return { posted: [], wakes: [], issues: {} };
    }

    const posted: string[] = [];
    const wakes: string[] = [];
    const issues: Record<string, string> = {};
    let warnedMissingOperator = false;

    for (const entry of input.entries) {
      const title = escalationTitle(input.runId, entry);
      let newlyDelivered = false;

      if (input.chronicleRepo !== undefined) {
        const tags = [
          'action-required',
          `trigger:${entry.trigger}`,
          `task:${entry.taskId}`,
          ...entry.context.slice(0, 2).map(c => `ctx:${c.slice(0, 80)}`),
          ...(input.evidenceIds ?? []).map(
            id => `evidence:${evidenceLink(input.runId, id)}`
          )
        ];
        if (this._queueRepo.appendItem(input.chronicleRepo, title, tags)) {
          newlyDelivered = true;
        }
      }

      if (input.repoPath !== undefined) {
        const issueResult = this.postIssue(input, entry, title);
        if (issueResult.url !== undefined) {
          issues[title] = issueResult.url;
        }
        if (issueResult.created === true) {
          newlyDelivered = true;
        }
        if (
          issueResult.created === true &&
          (input.operator === undefined || input.operator.length === 0) &&
          warnedMissingOperator === false
        ) {
          warnedMissingOperator = true;
          appendMonitor(
            input.monitorPath,
            `[escalate] WARNING: no operator configured — needs-human issue posted without assignee (${title})`
          );
        }
      }

      const wakeFile = this._wakeRepo.emitOnce({
        kind: 'sdlc_escalation',
        dedupeKey: title,
        occurrenceKey: input.occurrenceKey,
        prompt: `SDLC escalation: ${title}. Triage the needs-human issue / queue item, then resume the run.`,
        data: {
          runId: input.runId,
          taskId: entry.taskId,
          trigger: entry.trigger,
          issueUrl: issues[title]
        },
        wakeDir: input.wakeDir
      });
      if (wakeFile !== null) {
        wakes.push(title);
        newlyDelivered = true;
      }

      if (newlyDelivered === true) {
        posted.push(title);
      }
    }

    return { posted, wakes, issues };
  }

  /**
   * Best-effort GitHub issue create. Failures are swallowed so the run can
   * continue, but every swallow appends a loud monitor.log line.
   */
  private postIssue(
    input: EscalateInput,
    entry: ExceptionEntry,
    title: string
  ): { created: boolean; url?: string } {
    const repoPath = input.repoPath;
    if (repoPath === undefined) {
      return { created: false };
    }

    try {
      const existing = this._issueRepo.findByTitle(repoPath, title);
      if (existing !== null) {
        return { created: false, url: existing.url };
      }

      const assignee =
        input.operator !== undefined && input.operator.length > 0
          ? input.operator
          : undefined;
      const ref = this._issueRepo.create(repoPath, {
        title,
        body: escalationBody(input.runId, entry, input.evidenceIds),
        assignee
      });
      return { created: true, url: ref.url };
    } catch (err) {
      // WorkflowError buries the gh stderr in `details` (message is just
      // "gh issue failed") — join both or the loud line hides the cause.
      const detail =
        err instanceof WorkflowError
          ? [err.message, ...err.details].join(': ')
          : err instanceof Error
            ? err.message
            : String(err);
      appendMonitor(
        input.monitorPath,
        `[escalate] WARNING: failed to post needs-human GitHub issue for ${title}: ${detail.slice(0, 500)}`
      );
      return { created: false };
    }
  }
}
