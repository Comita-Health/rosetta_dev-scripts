import { injectable } from 'inversify';
import type { DurableWatchRecord, WatchKind } from '../types';

/** One source event with a stable adapter-owned identity. */
export interface WatchSourceSignal {
  /** Stable source event id, such as a GitHub review database id. */
  id: string;
  observedAt: string;
  prompt?: string;
  data?: Record<string, unknown>;
}

/** Result of polling one watch target once. */
export interface WatchSourcePollResult {
  signals: readonly WatchSourceSignal[];
  terminalState?: string;
}

/** Source-specific polling contract implemented by T-05 adapters. */
export interface IWatchSourceAdapter {
  poll(watch: DurableWatchRecord): Promise<WatchSourcePollResult>;
}

/** Late-bound adapter lookup keeps the scheduler source-agnostic. */
export interface IWatchSourceAdapterRegistry {
  get(kind: WatchKind): IWatchSourceAdapter | null;
}

/**
 * Mutable composition registry populated by source-adapter wiring.
 *
 * The daemon owns one singleton instance. T-05 can register adapters without
 * changing scheduler semantics or introducing source-specific dependencies.
 */
@injectable()
export class WatchSourceAdapterRegistry implements IWatchSourceAdapterRegistry {
  private readonly _adapters = new Map<WatchKind, IWatchSourceAdapter>();

  register(kind: WatchKind, adapter: IWatchSourceAdapter): void {
    this._adapters.set(kind, adapter);
  }

  get(kind: WatchKind): IWatchSourceAdapter | null {
    return this._adapters.get(kind) ?? null;
  }
}
