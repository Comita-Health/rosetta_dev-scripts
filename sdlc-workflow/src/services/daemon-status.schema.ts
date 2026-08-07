import type { JsonSchema } from '../utils/json-schema';

/**
 * Fixed schema for `sdlc-workflow daemon status --json`
 * (SPEC-PRD-0020-P1 T-07). Watches require kind/target/age/lastPollTime;
 * wakes require state pending|consumed; unwatched is always present.
 *
 * Nullable fields (`lastPollTime`, `degradedAt`, `lastError`, `consumedBy`)
 * are required for presence but omitted from `properties` type checks so
 * JSON `null` is accepted by the engine's minimal validator.
 */
export const DAEMON_STATUS_JSON_SCHEMA: JsonSchema = {
  type: 'object',
  required: ['workspaceRoot', 'watches', 'wakes', 'unwatched'],
  properties: {
    workspaceRoot: { type: 'string' },
    watches: {
      type: 'array',
      items: {
        type: 'object',
        required: [
          'id',
          'kind',
          'target',
          'age',
          'lastPollTime',
          'degraded',
          'degradedAt',
          'consecutiveFailures',
          'lastError'
        ],
        properties: {
          id: { type: 'string' },
          kind: { type: 'string' },
          target: { type: 'object' },
          age: { type: 'number' },
          degraded: { type: 'boolean' },
          consecutiveFailures: { type: 'number' }
        }
      }
    },
    wakes: {
      type: 'array',
      items: {
        type: 'object',
        required: [
          'id',
          'kind',
          'target',
          'signal',
          'createdAt',
          'state',
          'consumedBy'
        ],
        properties: {
          id: { type: 'string' },
          kind: { type: 'string' },
          target: { type: 'string' },
          signal: { type: 'string' },
          createdAt: { type: 'string' },
          state: { type: 'string', enum: ['pending', 'consumed'] }
        }
      }
    },
    unwatched: {
      type: 'array',
      items: {
        type: 'object',
        required: ['kind', 'target', 'source'],
        properties: {
          kind: { type: 'string' },
          target: { type: 'object' },
          source: { type: 'string' }
        }
      }
    }
  }
};
