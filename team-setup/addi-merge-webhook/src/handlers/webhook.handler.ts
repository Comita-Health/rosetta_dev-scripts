import { injectable, inject } from 'inversify';
import { ADDI_MERGE_WEBHOOK_TOKENS } from '../tokens.js';
import type { IReviewDispatchService } from '../services/review-dispatch.service.js';
import type { PullRequestReviewWebhook } from '../types.js';
import { verifyGitHubSignature256 } from '../utils/verify-signature.js';

export interface IWebhookHandler {
  handleHttp(input: {
    rawBody: Buffer;
    signatureHeader: string | undefined;
    eventName: string | undefined;
  }): Promise<{ status: number; body: Record<string, unknown> }>;
}

@injectable()
export class WebhookHandler implements IWebhookHandler {
  constructor(
    @inject(ADDI_MERGE_WEBHOOK_TOKENS.ReviewDispatchService)
    private readonly _reviewDispatch: IReviewDispatchService,
    @inject(ADDI_MERGE_WEBHOOK_TOKENS.WebhookSecret)
    private readonly _webhookSecret: string
  ) {}

  async handleHttp(input: {
    rawBody: Buffer;
    signatureHeader: string | undefined;
    eventName: string | undefined;
  }): Promise<{ status: number; body: Record<string, unknown> }> {
    if (
      !verifyGitHubSignature256(
        input.rawBody,
        input.signatureHeader,
        this._webhookSecret
      )
    ) {
      return { status: 401, body: { ok: false, error: 'invalid signature' } };
    }

    if (input.eventName !== 'pull_request_review') {
      return {
        status: 200,
        body: {
          ok: true,
          ignored: true,
          reason: `event=${input.eventName ?? ''}`
        }
      };
    }

    let payload: PullRequestReviewWebhook;
    try {
      payload = JSON.parse(
        input.rawBody.toString('utf8')
      ) as PullRequestReviewWebhook;
    } catch {
      return { status: 400, body: { ok: false, error: 'invalid json' } };
    }

    const result = await this._reviewDispatch.handlePullRequestReview(payload);
    return { status: 200, body: { ok: true, result } };
  }
}
