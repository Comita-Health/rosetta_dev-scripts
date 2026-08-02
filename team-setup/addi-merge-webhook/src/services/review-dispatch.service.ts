import { injectable, inject } from 'inversify';
import { ADDI_MERGE_WEBHOOK_TOKENS } from '../tokens.js';
import type { IGitHubDispatchRepository } from '../repositories/github-dispatch.repository.js';
import type { DispatchResult, PullRequestReviewWebhook } from '../types.js';

export interface IReviewDispatchService {
  handlePullRequestReview(
    payload: PullRequestReviewWebhook
  ): Promise<DispatchResult>;
}

@injectable()
export class ReviewDispatchService implements IReviewDispatchService {
  constructor(
    @inject(ADDI_MERGE_WEBHOOK_TOKENS.GitHubDispatchRepository)
    private readonly _dispatchRepo: IGitHubDispatchRepository
  ) {}

  async handlePullRequestReview(
    payload: PullRequestReviewWebhook
  ): Promise<DispatchResult> {
    if (payload.action !== 'submitted') {
      return { kind: 'ignored', reason: `action=${payload.action}` };
    }
    if (payload.review.state !== 'approved') {
      return {
        kind: 'ignored',
        reason: `review.state=${payload.review.state}`
      };
    }

    const owner = payload.repository.owner.login;
    const repo = payload.repository.name;
    const prNumber = payload.pull_request.number;

    await this._dispatchRepo.dispatchAddiMerge(owner, repo, prNumber);
    return {
      kind: 'dispatched',
      repo: `${owner}/${repo}`,
      prNumber
    };
  }
}
