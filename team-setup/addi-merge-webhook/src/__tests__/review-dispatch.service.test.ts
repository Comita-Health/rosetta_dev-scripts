import 'reflect-metadata';
import { Container } from 'inversify';
import { ADDI_MERGE_WEBHOOK_TOKENS } from '../tokens.js';
import { ReviewDispatchService } from '../services/review-dispatch.service.js';
import type { IGitHubDispatchRepository } from '../repositories/github-dispatch.repository.js';
import type { PullRequestReviewWebhook } from '../types.js';

describe('ReviewDispatchService', () => {
  let dispatch: jest.Mocked<IGitHubDispatchRepository>;
  let service: ReviewDispatchService;

  beforeEach(() => {
    dispatch = {
      dispatchAddiMerge: jest.fn().mockResolvedValue(undefined)
    };
    const container = new Container();
    container
      .bind(ADDI_MERGE_WEBHOOK_TOKENS.GitHubDispatchRepository)
      .toConstantValue(dispatch);
    container
      .bind(ADDI_MERGE_WEBHOOK_TOKENS.ReviewDispatchService)
      .to(ReviewDispatchService);
    service = container.get(ADDI_MERGE_WEBHOOK_TOKENS.ReviewDispatchService);
  });

  const base = (): PullRequestReviewWebhook => ({
    action: 'submitted',
    review: { state: 'approved' },
    pull_request: { number: 42 },
    repository: {
      full_name: 'Comita-Health/comita_admissions',
      name: 'comita_admissions',
      owner: { login: 'Comita-Health' }
    }
  });

  it('dispatches on approved review', async () => {
    const result = await service.handlePullRequestReview(base());
    expect(result).toEqual({
      kind: 'dispatched',
      repo: 'Comita-Health/comita_admissions',
      prNumber: 42
    });
    expect(dispatch.dispatchAddiMerge).toHaveBeenCalledWith(
      'Comita-Health',
      'comita_admissions',
      42
    );
  });

  it('ignores non-approved reviews', async () => {
    const payload = base();
    payload.review.state = 'changes_requested';
    const result = await service.handlePullRequestReview(payload);
    expect(result.kind).toBe('ignored');
    expect(dispatch.dispatchAddiMerge).not.toHaveBeenCalled();
  });
});
