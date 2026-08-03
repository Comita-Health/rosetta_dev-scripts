import { parseWebhookTenant } from '../utils/parse-tenant-path.js';

describe('parseWebhookTenant', () => {
  it('maps dual-org and legacy paths', () => {
    expect(parseWebhookTenant('/webhook')).toBe('legacy');
    expect(parseWebhookTenant('/webhook/rosetta')).toBe('rosetta');
    expect(parseWebhookTenant('/webhook/comita')).toBe('comita');
  });

  it('rejects unknown paths', () => {
    expect(parseWebhookTenant('/')).toBeNull();
    expect(parseWebhookTenant('/webhook/other')).toBeNull();
    expect(parseWebhookTenant('/health')).toBeNull();
  });
});
