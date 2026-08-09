import type {
  IDaemonStoreRepository,
  WakeWriteResult
} from '../repositories/daemon-store.repository';
import type { WatchSourceSignal } from '../services/watch-source-adapter';
import type { DurableWatchRecord } from '../types';

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
