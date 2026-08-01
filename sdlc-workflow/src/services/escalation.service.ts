import { inject, injectable } from 'inversify';
import type { IQueueRepository } from '../repositories/queue.repository';
import { WORKFLOW_TOKENS } from '../tokens';
import { ExceptionEntry } from '../types';
import { evidenceLink } from './digest.service';

export interface EscalateInput {
  /** Absent → queue items are skipped (no Chronicle, nothing to append to). */
  chronicleRepo?: string;
  runId: string;
  entries: ExceptionEntry[];
  /** Evidence IDs recorded for the task — linked in the queue item. */
  evidenceIds?: string[];
}

export interface EscalateOutcome {
  /** Titles of items actually appended (already-present titles excluded). */
  posted: string[];
}

/**
 * SPEC-PRD-0011-P3 T-06: turn exception-ledger entries into interrupting
 * action-required queue items. Each trigger posts one Inbox item naming the
 * task, the trigger, and the evidence refs — and the affected task is
 * halted by staying unmerged (T-01 / T-04), so only that task stops.
 * Idempotent by title: resume never duplicates an escalation item.
 */
export interface IEscalationService {
  post(input: EscalateInput): EscalateOutcome;
}

export const escalationTitle = (runId: string, entry: ExceptionEntry): string =>
  `ACTION REQUIRED: SDLC ${runId} ${entry.taskId} — ${entry.trigger}`;

@injectable()
export class EscalationService implements IEscalationService {
  constructor(
    @inject(WORKFLOW_TOKENS.QueueRepository)
    private readonly _queueRepo: IQueueRepository
  ) {}

  post(input: EscalateInput): EscalateOutcome {
    if (input.chronicleRepo === undefined || input.entries.length === 0) {
      return { posted: [] };
    }

    const posted: string[] = [];
    for (const entry of input.entries) {
      const title = escalationTitle(input.runId, entry);
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
        posted.push(title);
      }
    }
    return { posted };
  }
}
