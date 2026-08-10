import { appendFileSync, mkdirSync } from 'fs';
import { inject, injectable } from 'inversify';
import path from 'path';
import type { IIssueRepository } from '../repositories/issue.repository';
import type { IQueueRepository } from '../repositories/queue.repository';
import type { IWakeInboxRepository } from '../repositories/wake-inbox.repository';
import { WORKFLOW_TOKENS } from '../tokens';
import { ExceptionEntry, WorkflowError } from '../types';
import { evidenceLink } from './digest.service';
import {
  formatEscalationRefLines,
  type EscalationRefs
} from '../utils/escalation-refs';

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
  /**
   * Operator-facing references (blocker PR, branch/head, spec, human-required
   * criteria, CI check URLs, sandbox). When `prUrl` is set it remains the
   * primary jump target in the wake prompt.
   */
  refs?: EscalationRefs;
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
 * issues, and durable wake-inbox events.
 *
 * @remarks
 * One ACTION REQUIRED GitHub issue (and wake) per escalate **wave** —
 * same `runId` + `taskId` — even when the phase aggregator emits multiple
 * triggers (e.g. `reviewer-disagreement` + `envelope-breach`). Pre-fix
 * titles included the trigger and filed one issue per entry (#92/#93).
 * Queue tags still list every trigger. Idempotent by wave title on resume;
 * legacy per-trigger titles are reused when found open.
 */
export interface IEscalationService {
  post(input: EscalateInput): EscalateOutcome;
}

/** Stable wave title — no trigger suffix (one issue per task escalate wave). */
export const escalationWaveTitle = (runId: string, taskId: string): string =>
  `ACTION REQUIRED: SDLC ${runId} ${taskId}`;

/**
 * Title for a single exception entry. Task-scoped entries share the wave
 * title; run-level entries (no taskId) keep the trigger in the title.
 */
export const escalationTitle = (
  runId: string,
  entry: ExceptionEntry
): string => {
  if (entry.taskId !== undefined && entry.taskId.length > 0) {
    return escalationWaveTitle(runId, entry.taskId);
  }
  return `ACTION REQUIRED: SDLC ${runId} — ${entry.trigger}`;
};

/** Pre-wave-coalesce titles that still may be open in the wild. */
export const legacyEscalationTitle = (
  runId: string,
  taskId: string,
  trigger: ExceptionEntry['trigger']
): string => `ACTION REQUIRED: SDLC ${runId} ${taskId} — ${trigger}`;

const nonEmpty = (value: string | undefined): value is string =>
  value !== undefined && value.length > 0;

export const escalationBody = (
  runId: string,
  entries: ExceptionEntry[],
  evidenceIds: string[] | undefined,
  refs: EscalationRefs | undefined
): string => {
  const evidence =
    evidenceIds === undefined || evidenceIds.length === 0
      ? '_none_'
      : evidenceIds.map(id => `- \`${evidenceLink(runId, id)}\``).join('\n');
  const refLines =
    refs === undefined ? [] : formatEscalationRefLines(runId, refs);
  const afterMeta = refLines.length > 0 ? [...refLines, ''] : ([] as string[]);
  const triggers = entries.map(entry => entry.trigger);
  const uniqueTriggers = [...new Set(triggers)];
  const taskId = entries[0]?.taskId ?? '(run-level)';
  const contextBlocks: string[] = [];
  for (const entry of entries) {
    if (entries.length > 1) {
      contextBlocks.push(`#### ${entry.trigger}`);
    }
    if (entry.context.length === 0) {
      contextBlocks.push('- _(empty)_');
    } else {
      contextBlocks.push(...entry.context.map(line => `- ${line}`));
    }
  }
  return [
    `SDLC run \`${runId}\` needs human attention.`,
    '',
    `- **Task:** ${taskId}`,
    `- **Trigger:** ${uniqueTriggers.join(', ')}`,
    ...afterMeta,
    '### Context',
    ...contextBlocks,
    '',
    '### Evidence',
    evidence,
    '',
    '_Filed by sdlc-workflow escalation (fail-loud T-04)._'
  ].join('\n');
};

const queueRefTags = (refs: EscalationRefs | undefined): string[] => {
  if (refs === undefined) {
    return [];
  }
  const tags: string[] = [];
  if (nonEmpty(refs.prUrl)) {
    tags.push(`pr:${refs.prUrl}`);
  }
  if (nonEmpty(refs.branch)) {
    tags.push(`branch:${refs.branch}`);
  }
  if (nonEmpty(refs.headSha)) {
    tags.push(`head:${refs.headSha}`);
  }
  if (nonEmpty(refs.specPath)) {
    tags.push(`spec:${refs.specPath.slice(0, 120)}`);
  }
  for (const criterion of refs.humanRequired ?? []) {
    tags.push(`human-required:${criterion.slice(0, 80)}`);
  }
  for (const check of refs.ciCheckUrls ?? []) {
    tags.push(`ci:${check.url}`);
  }
  if (refs.sandbox?.evidenceId !== undefined) {
    tags.push(`sandbox-evidence:${refs.sandbox.evidenceId}`);
  }
  return tags;
};

const wakePromptFor = (
  title: string,
  refs: EscalationRefs | undefined
): string => {
  if (refs !== undefined && nonEmpty(refs.prUrl)) {
    return `SDLC escalation: ${title}. Open the blocker PR ${refs.prUrl}, triage the needs-human issue / queue item, then resume the run.`;
  }
  if (refs !== undefined && nonEmpty(refs.branch)) {
    return `SDLC escalation: ${title}. Inspect branch ${refs.branch}, triage the needs-human issue / queue item, then resume the run.`;
  }
  return `SDLC escalation: ${title}. Triage the needs-human issue / queue item, then resume the run.`;
};

const appendMonitor = (monitorPath: string | undefined, line: string): void => {
  if (monitorPath === undefined || monitorPath.length === 0) {
    return;
  }
  mkdirSync(path.dirname(monitorPath), { recursive: true });
  appendFileSync(monitorPath, `${line}\n`);
};

const groupEntriesByWave = (
  runId: string,
  entries: ExceptionEntry[]
): Map<string, ExceptionEntry[]> => {
  const groups = new Map<string, ExceptionEntry[]>();
  for (const entry of entries) {
    const title = escalationTitle(runId, entry);
    const group = groups.get(title) ?? [];
    group.push(entry);
    groups.set(title, group);
  }
  return groups;
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
    const refs = input.refs;
    const waves = groupEntriesByWave(input.runId, input.entries);

    for (const [title, group] of waves) {
      let newlyDelivered = false;
      const triggers = [...new Set(group.map(entry => entry.trigger))];
      const taskId = group[0]?.taskId;

      if (input.chronicleRepo !== undefined) {
        const tags = [
          'action-required',
          ...triggers.map(trigger => `trigger:${trigger}`),
          `task:${taskId ?? 'run'}`,
          ...group.flatMap(entry =>
            entry.context.slice(0, 2).map(c => `ctx:${c.slice(0, 80)}`)
          ),
          ...(input.evidenceIds ?? []).map(
            id => `evidence:${evidenceLink(input.runId, id)}`
          ),
          ...queueRefTags(refs)
        ];
        if (this._queueRepo.appendItem(input.chronicleRepo, title, tags)) {
          newlyDelivered = true;
        }
      }

      if (input.repoPath !== undefined) {
        const issueResult = this.postIssue(input, group, title, refs);
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
        prompt: wakePromptFor(title, refs),
        data: {
          runId: input.runId,
          taskId,
          trigger: triggers.join(','),
          issueUrl: issues[title],
          ...(refs !== undefined ? { refs } : {})
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
    entries: ExceptionEntry[],
    title: string,
    refs: EscalationRefs | undefined
  ): { created: boolean; url?: string } {
    const repoPath = input.repoPath;
    if (repoPath === undefined) {
      return { created: false };
    }

    try {
      const existing = this.findExistingIssue(repoPath, input.runId, entries);
      if (existing !== null) {
        return { created: false, url: existing.url };
      }

      const assignee =
        input.operator !== undefined && input.operator.length > 0
          ? input.operator
          : undefined;
      const ref = this._issueRepo.create(repoPath, {
        title,
        body: escalationBody(input.runId, entries, input.evidenceIds, refs),
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

  /**
   * Prefer the wave title; fall back to legacy per-trigger titles so resume
   * after this fix does not open a third issue next to #92/#93-style dupes.
   */
  private findExistingIssue(
    repoPath: string,
    runId: string,
    entries: ExceptionEntry[]
  ): { url: string; number: number } | null {
    const title = escalationTitle(runId, entries[0]!);
    const wave = this._issueRepo.findByTitle(repoPath, title);
    if (wave !== null) {
      return wave;
    }
    const taskId = entries[0]?.taskId;
    if (taskId === undefined || taskId.length === 0) {
      return null;
    }
    for (const entry of entries) {
      const legacy = this._issueRepo.findByTitle(
        repoPath,
        legacyEscalationTitle(runId, taskId, entry.trigger)
      );
      if (legacy !== null) {
        return legacy;
      }
    }
    return null;
  }
}
