import chalk from 'chalk';
import { inject, injectable } from 'inversify';
import type { ICiStatusRepository } from '../repositories/ci-status.repository';
import type { IPullRequestRepository } from '../repositories/pull-request.repository';
import { WORKFLOW_TOKENS } from '../tokens';
import type { GateVerdict } from '../types';
import {
  formatReviewerPrComment,
  parsePrNumber,
  REVIEWER_STATUS_CONTEXT,
  reviewerStatusState,
  truncateStatusDescription
} from '../utils/reviewer-publish';

export interface ReviewerPublishInput {
  repoPath: string;
  prUrl: string | undefined;
  headSha: string;
  runId: string;
  taskId: string;
  shadow: boolean;
  verdict?: GateVerdict;
}

/**
 * Surfaces the reviewer gate on the task PR: commit status (`sdlc/reviewer`)
 * plus an issue-style overview comment. Best-effort — GitHub failures must
 * not fail the run (local verdict + evidence remain authoritative).
 */
export interface IReviewerPublishService {
  /** Post `pending` before the reviewer agent starts. */
  markPending(input: ReviewerPublishInput): void;
  /** Post final status + PR comment after the reviewer returns. */
  publishResult(input: ReviewerPublishInput & { verdict: GateVerdict }): void;
}

@injectable()
export class ReviewerPublishService implements IReviewerPublishService {
  constructor(
    @inject(WORKFLOW_TOKENS.PullRequestRepository)
    private readonly _prRepo: IPullRequestRepository,
    @inject(WORKFLOW_TOKENS.CiStatusRepository)
    private readonly _ciStatus: ICiStatusRepository
  ) {}

  markPending(input: ReviewerPublishInput): void {
    this.safeStatus(input.repoPath, input.headSha, {
      state: 'pending',
      context: REVIEWER_STATUS_CONTEXT,
      description: truncateStatusDescription(
        `Reviewing ${input.taskId} (${input.shadow ? 'shadow' : 'enforce'})`
      )
    });
  }

  publishResult(input: ReviewerPublishInput & { verdict: GateVerdict }): void {
    const state = reviewerStatusState(input.verdict.outcome);
    const reasonPreview = input.verdict.reasons[0] ?? input.verdict.outcome;
    this.safeStatus(input.repoPath, input.headSha, {
      state,
      context: REVIEWER_STATUS_CONTEXT,
      description: truncateStatusDescription(
        `${input.taskId}: ${input.verdict.outcome} — ${reasonPreview}`
      ),
      targetUrl: input.prUrl
    });

    const prNumber = parsePrNumber(input.prUrl);
    if (prNumber === null) {
      console.log(
        chalk.yellow(
          '  [reviewer-publish] skip PR comment — no task PR URL in run state'
        )
      );
      return;
    }

    const body = formatReviewerPrComment({
      runId: input.runId,
      taskId: input.taskId,
      verdict: input.verdict,
      shadow: input.shadow
    });
    try {
      this._prRepo.comment(input.repoPath, prNumber, body);
      console.log(
        chalk.gray(`  [reviewer-publish] commented on PR #${prNumber}`)
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.log(
        chalk.yellow(
          `  [reviewer-publish] PR comment failed (non-fatal): ${message.slice(0, 200)}`
        )
      );
    }
  }

  private safeStatus(
    repoPath: string,
    sha: string,
    input: {
      state: 'error' | 'failure' | 'pending' | 'success';
      context: string;
      description?: string;
      targetUrl?: string;
    }
  ): void {
    if (sha.length === 0) {
      return;
    }
    try {
      this._ciStatus.createStatus(repoPath, sha, input);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.log(
        chalk.yellow(
          `  [reviewer-publish] status ${input.state} failed (non-fatal): ${message.slice(0, 200)}`
        )
      );
    }
  }
}
