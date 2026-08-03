import type { TenantId } from '../types.js';

/**
 * Map request pathname to a tenant. Prefer `/webhook/{tenant}`;
 * `/webhook` is the single-tenant legacy path.
 */
export const parseWebhookTenant = (
  pathname: string
): TenantId | 'legacy' | null => {
  if (pathname === '/webhook') {
    return 'legacy';
  }
  if (pathname === '/webhook/rosetta') {
    return 'rosetta';
  }
  if (pathname === '/webhook/comita') {
    return 'comita';
  }
  return null;
};
