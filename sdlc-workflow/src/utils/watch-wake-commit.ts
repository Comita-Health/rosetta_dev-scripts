import type {
  IDaemonStoreRepository,
  WakeWriteResult
} from '../repositories/daemon-store.repository';
import type { WatchSourceSignal } from '../services/watch-source-adapter';
import type { DurableWatchRecord } from '../types';

/** Prefix for operator-visible degraded/poll-error wake signals (P2 T-04). */
export const POLL_ERROR_SIGNAL_PREFIX = 'poll-error:';

/**
 * Stable `(kind, target, signal)` signal id for a watch poll-error wake.
 *
 * Idempotent per watch+reason: the same error text converges on one wake.
 */
export const pollErrorSignalId = (reason: string): string => {
  const normalized = reason.trim();
  if (normalized.length === 0) {
    return `${POLL_ERROR_SIGNAL_PREFIX}unknown`;
  }
  // Bound pathological messages so the ledger key stays readable.
  return `${POLL_ERROR_SIGNAL_PREFIX}${normalized.slice(0, 200)}`;
};

/**
 * Shared wake-inbox writer for watch-source signals (SPEC-PRD-0020-P1 T-04/T-05).
 *
 * Adapters emit {@link WatchSourceSignal} values; only this path (and callers
 * that deliberately reuse it) may publish them into the durable wake store.
 * Source adapters must not import the daemon store or call `writeWake` /
 * `emitOnce` themselves — the module-boundary test enforces that.
 */
export const commitWatchSignal = (
  store: IDaemonStoreRepository,
  workspaceRoot: string,
  watch: DurableWatchRecord,
  signal: WatchSourceSignal
): WakeWriteResult => {
  if (signal.id.trim().length === 0) {
    throw new TypeError('Watch source signal id must be non-empty');
  }
  if (Number.isNaN(Date.parse(signal.observedAt))) {
    throw new TypeError(
      'Watch source signal observedAt must be an ISO timestamp'
    );
  }
  const data: Record<string, unknown> = {
    ...(watch.resumeContext ?? {}),
    ...(signal.data ?? {})
  };
  return store.writeWake(workspaceRoot, {
    kind: watch.kind,
    target: watch.id,
    signal: signal.id,
    createdAt: signal.observedAt,
    ...(signal.prompt === undefined ? {} : { prompt: signal.prompt }),
    ...(Object.keys(data).length === 0 ? {} : { data })
  });
};

/**
 * Commit an operator-visible poll-error wake when a watch exceeds its
 * consecutive-failure cap (SPEC-PRD-0020-P2 T-04).
 *
 * Identity is `(watch.kind, watch.id, poll-error:<reason>)` via
 * {@link commitWatchSignal} / `writeWake`, so re-emitting the same
 * watch+reason is a no-op even after the wake has been consumed.
 */
export const commitPollErrorWake = (
  store: IDaemonStoreRepository,
  workspaceRoot: string,
  watch: DurableWatchRecord,
  error: unknown,
  observedAt: string = new Date().toISOString()
): WakeWriteResult => {
  const raw = error instanceof Error ? error.message : String(error);
  const reason = raw.trim().length === 0 ? 'unknown poll failure' : raw.trim();
  return commitWatchSignal(store, workspaceRoot, watch, {
    id: pollErrorSignalId(reason),
    observedAt,
    prompt: `Watch ${watch.id} exceeded its poll-failure cap and is degraded: ${reason}`,
    data: {
      signal: 'poll-error',
      reason,
      watchId: watch.id,
      kind: watch.kind
    }
  });
};
