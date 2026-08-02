import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Verify GitHub webhook HMAC (sha256) per
 * https://docs.github.com/webhooks/using-webhooks/validating-webhook-deliveries
 */
export const verifyGitHubSignature256 = (
  rawBody: Buffer,
  signatureHeader: string | undefined,
  secret: string
): boolean => {
  if (signatureHeader === undefined || signatureHeader.length === 0) {
    return false;
  }
  if (!signatureHeader.startsWith('sha256=')) {
    return false;
  }
  const expected = `sha256=${createHmac('sha256', secret)
    .update(rawBody)
    .digest('hex')}`;
  const a = Buffer.from(expected);
  const b = Buffer.from(signatureHeader);
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(a, b);
};
