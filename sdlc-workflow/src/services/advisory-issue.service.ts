import { appendFileSync, mkdirSync } from 'fs';
import { inject, injectable } from 'inversify';
import path from 'path';
import type { IIssueRepository } from '../repositories/issue.repository';
import type { IRunStateRepository } from '../repositories/run-state.repository';
import { WORKFLOW_TOKENS } from '../tokens';
import type { RunState } from '../types';
import { WorkflowError } from '../types';
import { evidenceLink } from './digest.service';
import {
  formatEscalationRefLines,
  type EscalationRefs
} from '../utils/escalation-refs';

/**
 * Who classified the proceed as risky — named in the advisory body so an
 * operator can tell agent self-label from engine strategy classification.
 */
export type RiskyClassificationSource = 'agent' | 'engine';

export interface AdvisoryIssueInput {
  runId: string;
  taskId: string;
  /**
   * Decision the train is continuing under (strategy / why it is risky).
   * Required — the advisory issue exists to name this for operators.
   */
  decision: string;
  /** `agent` when the unstick turn labeled risky; `engine` when the engine did. */
  classifiedBy: RiskyClassificationSource;
  /** Evidence IDs recorded for the task — linked in the issue body. */
  evidenceIds?: string[];
  /**
   * Operator-facing steps to course-correct after the train has moved on.
   * Absent → a short default ladder is used.
   */
  courseCorrect?: string[];
  /** Optional PR / branch / head / CI refs (same shape as escalations). */
  refs?: EscalationRefs;
  /** Target repo checkout for `gh issue create`. Absent → skip GitHub half. */
  repoPath?: string;
  /** Optional assignee; advisory issues may be assigned without blocking. */
  operator?: string;
  /** Path for loud post-failure warnings (default: skip file write). */
  monitorPath?: string;
  /**
   * When both are set, filing (or attempting to file) records escalate tier
   * `advisory-risky` on the task — never `halted-escalated`.
   */
  runsDir?: string;
  state?: RunState;
}

export interface AdvisoryIssueOutcome {
  /** Stable advisory title (never an ACTION REQUIRED wave title). */
  title: string;
  /** True when a new GitHub issue was created this call. */
  created: boolean;
  /** Issue URL created or reused (absent when GitHub was skipped / failed). */
  url?: string;
}

/**
 * SPEC-PRD-0025-P1 T-04: non-blocking advisory GitHub issues for risky
 * unstick proceeds.
 *
 * @remarks
 * Distinct class from {@link EscalationService} / `escalationWaveTitle`
 * ACTION REQUIRED issues. Filing keeps the train moving: no
 * `action-required` queue item, no wake-inbox `sdlc_escalation`, and no
 * exception-ledger entries that {@link BlockerService} treats as open
 * needs-human blockers. Escalate tier becomes `advisory-risky`.
 */
export interface IAdvisoryIssueService {
  file(input: AdvisoryIssueInput): AdvisoryIssueOutcome;
}

/**
 * Advisory title class — must never match
 * `ACTION REQUIRED: SDLC <runId> <taskId>`.
 */
export const advisoryIssueTitle = (runId: string, taskId: string): string =>
  `ADVISORY: SDLC ${runId} ${taskId} risky proceed`;

const DEFAULT_COURSE_CORRECT = [
  'Review the decision and linked evidence; decide whether a follow-up fix is needed.',
  'If course-correction is required, land it on a follow-up PR — do not reopen this wave as a Continuity resume gate.',
  'Leave this advisory open or close it after triage; closing it is not required for the run to continue.'
];

/**
 * Markdown body for a risky-proceed advisory. Names the decision, evidence
 * links, and course-correct steps — never the ACTION REQUIRED escalate copy.
 */
export const advisoryIssueBody = (
  runId: string,
  taskId: string,
  decision: string,
  classifiedBy: RiskyClassificationSource,
  evidenceIds: string[] | undefined,
  courseCorrect: string[] | undefined,
  refs: EscalationRefs | undefined
): string => {
  const evidence =
    evidenceIds === undefined || evidenceIds.length === 0
      ? '_none_'
      : evidenceIds.map(id => `- \`${evidenceLink(runId, id)}\``).join('\n');
  const steps =
    courseCorrect !== undefined && courseCorrect.length > 0
      ? courseCorrect
      : DEFAULT_COURSE_CORRECT;
  const refLines =
    refs === undefined ? [] : formatEscalationRefLines(runId, refs);
  const afterMeta = refLines.length > 0 ? [...refLines, ''] : ([] as string[]);
  return [
    `SDLC run \`${runId}\` continued after a **risky proceed** (non-blocking advisory).`,
    '',
    `- **Task:** ${taskId}`,
    `- **Classified by:** ${classifiedBy}`,
    `- **Decision:** ${decision}`,
    ...afterMeta,
    '### Evidence',
    evidence,
    '',
    '### How to course-correct',
    ...steps.map(step => `- ${step}`),
    '',
    '_Filed by sdlc-workflow advisory-issue (SPEC-PRD-0025-P1 T-04). This is not an ACTION REQUIRED resume gate._'
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
export class AdvisoryIssueService implements IAdvisoryIssueService {
  constructor(
    @inject(WORKFLOW_TOKENS.IssueRepository)
    private readonly _issueRepo: IIssueRepository,
    @inject(WORKFLOW_TOKENS.RunStateRepository)
    private readonly _runStateRepo: IRunStateRepository
  ) {}

  /**
   * File (or reuse) a non-blocking advisory issue for a risky unstick proceed
   * and set the task escalate tier to `advisory-risky`.
   *
   * @remarks
   * **Invariants.**
   * - Title is always {@link advisoryIssueTitle} — never `ACTION REQUIRED:…`.
   * - Does not append Chronicle `action-required` queue items, emit
   *   wake-inbox escalations, or write exception-ledger entries.
   * - Escalate tier is set to `advisory-risky` whenever `runsDir` + `state`
   *   are provided, even when GitHub create is skipped or fails — the train
   *   must not look `halted-escalated` after a risky continue.
   * - GitHub failures are swallowed with a loud `monitor.log` line (same
   *   fail-soft posture as {@link EscalationService}).
   */
  file(input: AdvisoryIssueInput): AdvisoryIssueOutcome {
    const title = advisoryIssueTitle(input.runId, input.taskId);
    this.recordAdvisoryRiskyTier(input);

    if (input.repoPath === undefined || input.repoPath.length === 0) {
      return { title, created: false };
    }

    try {
      const existing = this._issueRepo.findByTitle(input.repoPath, title);
      if (existing !== null) {
        return { title, created: false, url: existing.url };
      }

      const assignee =
        input.operator !== undefined && input.operator.length > 0
          ? input.operator
          : undefined;
      const ref = this._issueRepo.create(input.repoPath, {
        title,
        body: advisoryIssueBody(
          input.runId,
          input.taskId,
          input.decision,
          input.classifiedBy,
          input.evidenceIds,
          input.courseCorrect,
          input.refs
        ),
        assignee
      });
      return { title, created: true, url: ref.url };
    } catch (err) {
      const detail =
        err instanceof WorkflowError
          ? [err.message, ...err.details].join(': ')
          : err instanceof Error
            ? err.message
            : String(err);
      appendMonitor(
        input.monitorPath,
        `[advisory] WARNING: failed to post non-blocking advisory GitHub issue for ${title}: ${detail.slice(0, 500)}`
      );
      return { title, created: false };
    }
  }

  private recordAdvisoryRiskyTier(input: AdvisoryIssueInput): void {
    if (
      input.runsDir === undefined ||
      input.runsDir.length === 0 ||
      input.state === undefined
    ) {
      return;
    }
    this._runStateRepo.recordEscalateTier(
      input.runsDir,
      input.state,
      input.taskId,
      'advisory-risky'
    );
  }
}

/** True when a title is the human-blocking ACTION REQUIRED escalate class. */
export const isActionRequiredEscalationTitle = (title: string): boolean =>
  title.startsWith('ACTION REQUIRED: SDLC ');

/** True when a title is the non-blocking advisory class for risky proceeds. */
export const isAdvisoryIssueTitle = (title: string): boolean =>
  title.startsWith('ADVISORY: SDLC ') && title.endsWith(' risky proceed');
