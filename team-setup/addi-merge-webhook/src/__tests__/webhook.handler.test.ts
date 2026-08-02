import 'reflect-metadata';
import { createHmac } from 'node:crypto';
import { Container } from 'inversify';
import { ADDI_MERGE_WEBHOOK_TOKENS } from '../tokens.js';
import { WebhookHandler } from '../handlers/webhook.handler.js';
import type { IReviewDispatchService } from '../services/review-dispatch.service.js';

describe('WebhookHandler', () => {
  const secret = 'hook-secret';
  let review: jest.Mocked<IReviewDispatchService>;
  let handler: WebhookHandler;

  beforeEach(() => {
    review = {
      handlePullRequestReview: jest.fn().mockResolvedValue({
        kind: 'dispatched',
        repo: 'o/r',
        prNumber: 1
      })
    };
    const container = new Container();
    container
      .bind(ADDI_MERGE_WEBHOOK_TOKENS.ReviewDispatchService)
      .toConstantValue(review);
    container
      .bind(ADDI_MERGE_WEBHOOK_TOKENS.WebhookSecret)
      .toConstantValue(secret);
    container.bind(ADDI_MERGE_WEBHOOK_TOKENS.WebhookHandler).to(WebhookHandler);
    handler = container.get(ADDI_MERGE_WEBHOOK_TOKENS.WebhookHandler);
  });

  const sign = (body: Buffer): string =>
    `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

  it('rejects invalid signatures', async () => {
    const rawBody = Buffer.from('{}');
    const res = await handler.handleHttp({
      rawBody,
      signatureHeader: 'sha256=nope',
      eventName: 'pull_request_review'
    });
    expect(res.status).toBe(401);
  });

  it('ignores non-review events', async () => {
    const rawBody = Buffer.from('{}');
    const res = await handler.handleHttp({
      rawBody,
      signatureHeader: sign(rawBody),
      eventName: 'ping'
    });
    expect(res.status).toBe(200);
    expect(res.body.ignored).toBe(true);
    expect(review.handlePullRequestReview).not.toHaveBeenCalled();
  });

  it('dispatches approved pull_request_review payloads', async () => {
    const rawBody = Buffer.from(
      JSON.stringify({
        action: 'submitted',
        review: { state: 'approved' },
        pull_request: { number: 1 },
        repository: {
          full_name: 'o/r',
          name: 'r',
          owner: { login: 'o' }
        }
      })
    );
    const res = await handler.handleHttp({
      rawBody,
      signatureHeader: sign(rawBody),
      eventName: 'pull_request_review'
    });
    expect(res.status).toBe(200);
    expect(review.handlePullRequestReview).toHaveBeenCalled();
  });
});
