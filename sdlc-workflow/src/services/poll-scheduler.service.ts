import { inject, injectable } from 'inversify';
import type { IDaemonStoreRepository } from '../repositories/daemon-store.repository';
import { WORKFLOW_TOKENS } from '../tokens';
import type { ActiveWatch, DurableWatchRecord } from '../types';
import type { IWatchRegistryService } from './watch-registry.service';
import type {
  IWatchSourceAdapterRegistry,
  WatchSourceSignal
} from './watch-source-adapter';

export const DEFAULT_POLL_FAILURE_CAP = 3;
export const DEFAULT_POLL_LEASE_MILLISECONDS = 5 * 60 * 1_000;

export interface PollTickOptions {
  failureCap?: number;
  leaseMilliseconds?: number;
}

export interface IPollSchedulerService {
  start(
    workspaceRoot: string,
    tickSeconds: number,
    options?: PollTickOptions
  ): void;
  tick(workspaceRoot: string, options?: PollTickOptions): Promise<void>;
  stop(): void;
}

/**
 * Cadence-aware watch poller with one durable in-flight lease per watch.
 *
 * Adapter signals are committed through the daemon store's permanent wake
 * ledger before poll success is recorded. A crash after that commit causes
 * the next poll to rediscover the same adapter signal, whose stable id maps
 * back to the original wake rather than publishing another.
 */
@injectable()
export class PollSchedulerService implements IPollSchedulerService {
  private _timer: ReturnType<typeof setInterval> | null = null;

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
    tickSeconds: number,
    options: PollTickOptions = {}
  ): void {
    if (Number.isSafeInteger(tickSeconds) === false || tickSeconds <= 0) {
      throw new TypeError(
        'Poll scheduler tickSeconds must be a positive integer'
      );
    }
    this.stop();
    void this.runTick(workspaceRoot, options);
    this._timer = setInterval(
      () => void this.runTick(workspaceRoot, options),
      tickSeconds * 1_000
    );
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
      .filter(watch => this.isDue(watch));
    await Promise.all(
      due.map(watch =>
        this.pollWatch(workspaceRoot, watch, failureCap, leaseMilliseconds)
      )
    );
  }

  stop(): void {
    if (this._timer !== null) {
      clearInterval(this._timer);
      this._timer = null;
    }
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
    }
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
        throw new Error(`No source adapter registered for ${watch.kind}`);
      }
      const result = await adapter.poll(watch);
      for (const signal of result.signals) {
        this.commitSignal(workspaceRoot, watch, signal);
      }
      this._watches.recordPoll(workspaceRoot, watch.id, {
        terminalState: result.terminalState
      });
    } catch (error) {
      this._watches.recordPollFailure(
        workspaceRoot,
        listed.id,
        error,
        failureCap
      );
    } finally {
      this._store.releasePollLease(workspaceRoot, lease);
    }
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
    if (signal.id.trim().length === 0) {
      throw new TypeError('Watch source signal id must be non-empty');
    }
    if (Number.isNaN(Date.parse(signal.observedAt))) {
      throw new TypeError(
        'Watch source signal observedAt must be an ISO timestamp'
      );
    }
    this._store.writeWake(workspaceRoot, {
      kind: watch.kind,
      target: watch.id,
      signal: signal.id,
      createdAt: signal.observedAt,
      ...(signal.prompt === undefined ? {} : { prompt: signal.prompt }),
      ...(signal.data === undefined ? {} : { data: signal.data })
    });
  }
}
