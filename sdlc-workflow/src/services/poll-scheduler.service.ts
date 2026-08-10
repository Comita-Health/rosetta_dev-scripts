import { inject, injectable } from 'inversify';
import type { IDaemonStoreRepository } from '../repositories/daemon-store.repository';
import { WORKFLOW_TOKENS } from '../tokens';
import type { ActiveWatch, DurableWatchRecord, WatchKind } from '../types';
import { exitDaemonFatal } from '../utils/daemon-exit';
import {
  commitPollErrorWake,
  commitWatchSignal
} from '../utils/watch-wake-commit';
import type { IWatchRegistryService } from './watch-registry.service';
import type {
  IWatchSourceAdapterRegistry,
  WatchSourceSignal
} from './watch-source-adapter';

export const DEFAULT_POLL_FAILURE_CAP = 3;
export const DEFAULT_POLL_LEASE_MILLISECONDS = 5 * 60 * 1_000;
/** Floor on the timer interval, so a 1-second watch cannot become a hot loop. */
export const MINIMUM_POLL_TICK_MILLISECONDS = 1_000;

export interface PollTickOptions {
  failureCap?: number;
  leaseMilliseconds?: number;
}

export interface IPollSchedulerService {
  /**
   * Arm the loop, evaluating watches at least as often as the shortest
   * declared cadence among them.
   *
   * @param maxTickSeconds - Idle cadence ceiling (the daemon's
   * `defaultPollSeconds`): the timer never sleeps longer than this, and
   * sleeps less when a watch declares a shorter `pollSeconds`.
   */
  start(
    workspaceRoot: string,
    maxTickSeconds: number,
    options?: PollTickOptions
  ): void;
  tick(workspaceRoot: string, options?: PollTickOptions): Promise<void>;
  stop(): void;
}

/**
 * Cadence-aware watch poller with one durable in-flight lease per watch.
 *
 * Each tick evaluates every active watch against *its own* `pollSeconds`, and
 * the timer between ticks is the shortest cadence among the active watches
 * (bounded below by {@link MINIMUM_POLL_TICK_MILLISECONDS} and above by the
 * caller's ceiling). A watch that polls faster than the daemon's default
 * cadence is therefore still visited on the cadence it declared.
 *
 * Adapter signals are committed through the daemon store's permanent wake
 * ledger before poll success is recorded. A crash after that commit causes
 * the next poll to rediscover the same adapter signal, whose stable id maps
 * back to the original wake rather than publishing another.
 *
 * A watch whose kind has no registered source adapter is skipped, not failed:
 * a missing adapter is a composition gap, not a signal-source fault, so it
 * must not consume the watch's bounded failure budget or degrade it. While the
 * adapter registry is empty the loop does no polling work at all — it says so
 * once and keeps its timer. Phase 1 registers the GitHub adapters
 * (SPEC-PRD-0020-P1 T-05) into this registry at process start.
 *
 * When a watch exceeds the consecutive-failure cap the scheduler commits an
 * operator-visible `poll-error` wake (idempotent per watch+reason) before
 * flipping `degradedAt` — not only the degraded flag (SPEC-PRD-0020-P2 T-04).
 * Unrecoverable top-level tick errors exit non-zero so launchd KeepAlive
 * restarts the process; per-watch poll failures never exit 0 as success.
 */
@injectable()
export class PollSchedulerService implements IPollSchedulerService {
  private _timer: ReturnType<typeof setTimeout> | null = null;
  private _running = false;
  private _reportedEmptyRegistry = false;
  private readonly _reportedMissingKinds = new Set<WatchKind>();

  constructor(
    @inject(WORKFLOW_TOKENS.WatchRegistryService)
    private readonly _watches: IWatchRegistryService,
    @inject(WORKFLOW_TOKENS.DaemonStoreRepository)
    private readonly _store: IDaemonStoreRepository,
    @inject(WORKFLOW_TOKENS.WatchSourceAdapterRegistry)
    private readonly _adapters: IWatchSourceAdapterRegistry
  ) {}

  start(
    workspaceRoot: string,
    maxTickSeconds: number,
    options: PollTickOptions = {}
  ): void {
    if (Number.isSafeInteger(maxTickSeconds) === false || maxTickSeconds <= 0) {
      throw new TypeError(
        'Poll scheduler maxTickSeconds must be a positive integer'
      );
    }
    this.stop();
    this._running = true;
    void this.cycle(workspaceRoot, maxTickSeconds, options);
  }

  async tick(
    workspaceRoot: string,
    options: PollTickOptions = {}
  ): Promise<void> {
    const failureCap = options.failureCap ?? DEFAULT_POLL_FAILURE_CAP;
    const leaseMilliseconds =
      options.leaseMilliseconds ?? DEFAULT_POLL_LEASE_MILLISECONDS;
    const due = this._watches
      .list(workspaceRoot)
      .filter(watch => this.isDue(watch) && this.hasAdapter(watch.kind));
    await Promise.all(
      due.map(watch =>
        this.pollWatch(workspaceRoot, watch, failureCap, leaseMilliseconds)
      )
    );
  }

  stop(): void {
    this._running = false;
    if (this._timer !== null) {
      clearTimeout(this._timer);
      this._timer = null;
    }
  }

  /** One tick plus the timer for the next one, re-derived from live cadences. */
  private async cycle(
    workspaceRoot: string,
    maxTickSeconds: number,
    options: PollTickOptions
  ): Promise<void> {
    if (this._adapters.kinds().length === 0) {
      // Nothing can be polled yet, and polling anyway would spend every
      // watch's failure budget on the daemon's own wiring gap. The loop keeps
      // its timer so registration picks up from the next tick onwards.
      this.reportEmptyRegistry();
    } else {
      this._reportedEmptyRegistry = false;
      await this.runTick(workspaceRoot, options);
    }
    if (this._running === false) {
      return;
    }
    this._timer = setTimeout(
      () => void this.cycle(workspaceRoot, maxTickSeconds, options),
      this.nextTickMilliseconds(workspaceRoot, maxTickSeconds)
    );
  }

  private async runTick(
    workspaceRoot: string,
    options: PollTickOptions
  ): Promise<void> {
    try {
      await this.tick(workspaceRoot, options);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.error(`[poll-scheduler] tick failed: ${detail}`);
      // Unrecoverable: exit non-zero so launchd KeepAlive restarts.
      // Per-watch adapter failures are caught in pollWatch and never reach here.
      exitDaemonFatal('unrecoverable-tick', detail);
    }
  }

  /**
   * Sleep no longer than the shortest cadence any active watch declares, so
   * per-watch cadence — not the daemon default — sets the evaluation rate.
   * Falls back to the ceiling when the registry cannot be read; an unreadable
   * registry is already reported by the tick itself.
   */
  private nextTickMilliseconds(
    workspaceRoot: string,
    maxTickSeconds: number
  ): number {
    const ceiling = maxTickSeconds * 1_000;
    if (this._adapters.kinds().length === 0) {
      // Nothing to poll: wake on the daemon's own cadence, not a watch's.
      return ceiling;
    }
    let cadences: number[];
    try {
      cadences = this._watches
        .list(workspaceRoot)
        .filter(watch => watch.degradedAt === null)
        .map(watch => watch.pollSeconds * 1_000);
    } catch {
      return ceiling;
    }
    return Math.max(
      MINIMUM_POLL_TICK_MILLISECONDS,
      Math.min(ceiling, ...cadences)
    );
  }

  /** Say once, not every tick, that there is nothing to poll with. */
  private reportEmptyRegistry(): void {
    if (this._reportedEmptyRegistry === true) {
      return;
    }
    this._reportedEmptyRegistry = true;
    console.error(
      '[poll-scheduler] no watch source adapters are registered; watches stay ' +
        'registered and unpolled until source adapters are wired in'
    );
  }

  private hasAdapter(kind: WatchKind): boolean {
    if (this._adapters.get(kind) !== null) {
      this._reportedMissingKinds.delete(kind);
      return true;
    }
    if (this._reportedMissingKinds.has(kind) === false) {
      this._reportedMissingKinds.add(kind);
      console.error(
        `[poll-scheduler] no source adapter registered for ${kind}; ` +
          'its watches stay registered and unpolled'
      );
    }
    return false;
  }

  private isDue(watch: ActiveWatch): boolean {
    if (watch.degradedAt !== null) {
      return false;
    }
    if (watch.lastPollTime === null) {
      return true;
    }
    return (
      Date.now() - Date.parse(watch.lastPollTime) >= watch.pollSeconds * 1_000
    );
  }

  private async pollWatch(
    workspaceRoot: string,
    listed: ActiveWatch,
    failureCap: number,
    leaseMilliseconds: number
  ): Promise<void> {
    const lease = this._store.tryAcquirePollLease(
      workspaceRoot,
      listed.id,
      leaseMilliseconds
    );
    if (lease === null) {
      return;
    }

    try {
      const watch = this._watches.get(workspaceRoot, listed.id);
      if (watch === null || this.isRecordDue(watch) === false) {
        return;
      }
      const adapter = this._adapters.get(watch.kind);
      if (adapter === null) {
        return;
      }
      const result = await adapter.poll(workspaceRoot, watch);
      for (const signal of result.signals) {
        this.commitSignal(workspaceRoot, watch, signal);
      }
      this._watches.recordPoll(workspaceRoot, watch.id, {
        terminalState: result.terminalState
      });
    } catch (error) {
      this.recordFailureAndMaybeWake(
        workspaceRoot,
        listed.id,
        error,
        failureCap
      );
    } finally {
      this._store.releasePollLease(workspaceRoot, lease);
    }
  }

  /**
   * Record a bounded poll failure; when the cap is reached, commit a
   * `poll-error` wake first (idempotent) so a crash between wake and
   * degrade still rediscovers the same wake on the next attempt.
   */
  private recordFailureAndMaybeWake(
    workspaceRoot: string,
    watchId: string,
    error: unknown,
    failureCap: number
  ): void {
    const current = this._watches.get(workspaceRoot, watchId);
    if (current !== null && current.degradedAt === undefined) {
      const nextFailures = (current.consecutiveFailures ?? 0) + 1;
      if (nextFailures >= failureCap) {
        commitPollErrorWake(this._store, workspaceRoot, current, error);
      }
    }
    this._watches.recordPollFailure(workspaceRoot, watchId, error, failureCap);
  }

  private isRecordDue(watch: DurableWatchRecord): boolean {
    if (watch.degradedAt !== undefined) {
      return false;
    }
    if (watch.lastPollTime === undefined) {
      return true;
    }
    return (
      Date.now() - Date.parse(watch.lastPollTime) >= watch.pollSeconds * 1_000
    );
  }

  private commitSignal(
    workspaceRoot: string,
    watch: DurableWatchRecord,
    signal: WatchSourceSignal
  ): void {
    commitWatchSignal(this._store, workspaceRoot, watch, signal);
  }
}
