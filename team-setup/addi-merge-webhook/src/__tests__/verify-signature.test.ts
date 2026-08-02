import { createHmac } from 'node:crypto';
import { verifyGitHubSignature256 } from '../utils/verify-signature.js';

describe('verifyGitHubSignature256', () => {
  const secret = 'test-secret';
  const body = Buffer.from('{"ok":true}');

  it('accepts a valid sha256 signature', () => {
    const sig = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
    expect(verifyGitHubSignature256(body, sig, secret)).toBe(true);
  });

  it('rejects missing or malformed signatures', () => {
    expect(verifyGitHubSignature256(body, undefined, secret)).toBe(false);
    expect(verifyGitHubSignature256(body, 'sha1=abc', secret)).toBe(false);
    expect(verifyGitHubSignature256(body, 'sha256=deadbeef', secret)).toBe(
      false
    );
  });
});
