/**
 * Map request pathname to a tenant slug.
 * Prefer `/webhook/{tenant}`; `/webhook` is the single-tenant legacy path.
 *
 * Any slug matching `^[a-z][a-z0-9-]*$` is accepted here. Whether the tenant
 * is configured is decided by the handler registry, not this parser — so a
 * second consumer is an env/secret entry, not a code change.
 */
export const parseWebhookTenant = (
  pathname: string
): string | 'legacy' | null => {
  if (pathname === '/webhook') {
    return 'legacy';
  }
  const match = /^\/webhook\/([a-z][a-z0-9-]*)$/.exec(pathname);
  if (match === null) {
    return null;
  }
  return match[1];
};
