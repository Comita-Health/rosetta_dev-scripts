import { parseWebhookTenant } from '../utils/parse-tenant-path.js';

describe('parseWebhookTenant', () => {
  it('maps legacy and any valid tenant slug', () => {
    expect(parseWebhookTenant('/webhook')).toBe('legacy');
    expect(parseWebhookTenant('/webhook/rosetta')).toBe('rosetta');
    expect(parseWebhookTenant('/webhook/acme')).toBe('acme');
  });

  it('rejects unknown paths', () => {
    expect(parseWebhookTenant('/')).toBeNull();
    expect(parseWebhookTenant('/webhook/Other')).toBeNull();
    expect(parseWebhookTenant('/webhook/bad_slug')).toBeNull();
    expect(parseWebhookTenant('/health')).toBeNull();
  });
});
