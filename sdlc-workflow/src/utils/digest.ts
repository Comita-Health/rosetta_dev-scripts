import { createHash } from 'crypto';

/**
 * Deterministic JSON stringify: object keys sorted recursively so the same
 * logical value always digests identically.
 */
export const stableStringify = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
};

/**
 * SHA-256 digest of a value's stable JSON form — the cache key material for
 * the T-09 step graph and the `inputsDigest` on gate verdicts (T-08).
 */
export const inputsDigest = (value: unknown): string =>
  createHash('sha256').update(stableStringify(value)).digest('hex');
