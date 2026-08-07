import { createHash } from 'crypto';
import { WakeEventInput } from '../types';

/**
 * Derive a stable wake identity from an unambiguous tuple encoding. Payload
 * metadata is intentionally excluded so retries of one observed signal map
 * to the same durable record.
 */
export const wakeEventId = (
  input: Pick<WakeEventInput, 'kind' | 'target' | 'signal'>
): string =>
  createHash('sha256')
    .update(JSON.stringify([input.kind, input.target, input.signal]))
    .digest('hex');
