import { inject, injectable } from 'inversify';
import type {
  GitHubPrReview,
  GitHubPrReviewComment,
  IGitHubWatchSourceRepository
} from '../repositories/github-watch-source.repository';
import { WORKFLOW_TOKENS } from '../tokens';
import type { DurableWatchRecord } from '../types';
import type {
  IWatchSourceAdapter,
  WatchSourcePollResult,
  WatchSourceSignal
} from './watch-source-adapter';

const isBot = (userType: string): boolean => userType === 'Bot';

const requirePrTarget = (
  watch: DurableWatchRecord
): { repo: string; number: number } => {
  const repo = watch.target.repo;
  const number = watch.target.number;
  if (typeof repo !== 'string' || repo.trim().length === 0) {
    throw new TypeError('pr-review adapter requires target.repo');
  }
  if (typeof number !== 'number' || Number.isSafeInteger(number) === false) {
    throw new TypeError('pr-review adapter requires target.number');
  }
  return { repo: repo.trim(), number };
};

const observedAt = (value: string | null, fallback: string): string => {
  if (value !== null && Number.isNaN(Date.parse(value)) === false) {
    return value;
  }
  return fallback;
};

/**
 * Phase 1 `pr-review` source adapter (SPEC-PRD-0020-P1 T-05).
 *
 * Normalizes human Approve, Request-changes, and new inline review-comment
 * events into distinct {@link WatchSourceSignal} values. Delivery into the
 * wake inbox is the poll scheduler's job via the shared commit helper — this
 * class never touches the wake store.
 */
@injectable()
export class PrReviewWatchSourceAdapter implements IWatchSourceAdapter {
  constructor(
    @inject(WORKFLOW_TOKENS.GitHubWatchSourceRepository)
    private readonly _github: IGitHubWatchSourceRepository
  ) {}

  async poll(
    workspaceRoot: string,
    watch: DurableWatchRecord
  ): Promise<WatchSourcePollResult> {
    const { repo, number } = requirePrTarget(watch);
    const pr = this._github.getPullRequest(workspaceRoot, repo, number);
    if (pr.state === 'MERGED' || pr.state === 'CLOSED') {
      return { signals: [], terminalState: pr.state.toLowerCase() };
    }

    const now = new Date().toISOString();
    const signals: WatchSourceSignal[] = [];

    for (const review of this._github.listReviews(
      workspaceRoot,
      repo,
      number
    )) {
      const signal = this.reviewSignal(repo, number, review, now);
      if (signal !== null) {
        signals.push(signal);
      }
    }

    for (const comment of this._github.listReviewComments(
      workspaceRoot,
      repo,
      number
    )) {
      const signal = this.commentSignal(repo, number, comment, now);
      if (signal !== null) {
        signals.push(signal);
      }
    }

    return { signals };
  }

  private reviewSignal(
    repo: string,
    number: number,
    review: GitHubPrReview,
    fallbackAt: string
  ): WatchSourceSignal | null {
    if (isBot(review.userType)) {
      return null;
    }
    if (review.state === 'APPROVED') {
      return {
        id: `approved:${review.id}`,
        observedAt: observedAt(review.submittedAt, fallbackAt),
        prompt: `PR ${repo}#${number} approved by ${review.userLogin}`,
        data: {
          signal: 'approved',
          repo,
          number,
          reviewId: review.id,
          login: review.userLogin
        }
      };
    }
    if (review.state === 'CHANGES_REQUESTED') {
      return {
        id: `changes_requested:${review.id}`,
        observedAt: observedAt(review.submittedAt, fallbackAt),
        prompt: `PR ${repo}#${number} changes requested by ${review.userLogin}`,
        data: {
          signal: 'changes_requested',
          repo,
          number,
          reviewId: review.id,
          login: review.userLogin,
          body: review.body
        }
      };
    }
    return null;
  }

  private commentSignal(
    repo: string,
    number: number,
    comment: GitHubPrReviewComment,
    fallbackAt: string
  ): WatchSourceSignal | null {
    if (isBot(comment.userType)) {
      return null;
    }
    return {
      id: `review_comment:${comment.id}`,
      observedAt: observedAt(comment.createdAt, fallbackAt),
      prompt: `New review comment on ${repo}#${number} by ${comment.userLogin}`,
      data: {
        signal: 'review_comment',
        repo,
        number,
        commentId: comment.id,
        login: comment.userLogin,
        path: comment.path,
        body: comment.body
      }
    };
  }
}
