import { inject, injectable } from 'inversify';
import type { IDaemonStoreRepository } from '../repositories/daemon-store.repository';
import { WORKFLOW_TOKENS } from '../tokens';
import type { WakeEvent } from '../types';
import type { IWakeActionRegistry } from './wake-action';

/** Default consumer id stamped by the long-running daemon process. */
export const DEFAULT_WAKE_CONSUMER_ID = 'daemon';

/** Floor on the consume-loop timer so a 0s config cannot become a hot loop. */
export const MINIMUM_CONSUME_TICK_MILLISECONDS = 1_000;

export interface WakeConsumeOptions {
  /** Value written to `consumedBy` for wakes this pass claims. */
  consumerId?: string;
}

export interface WakeConsumeTickResult {
  claimed: WakeEvent[];
  /** Wakes claimed this tick that recorded at least one action failure. */
  actionFailures: WakeEvent[];
}

export interface IWakeConsumptionService {
  /**
   * Arm the loop that claims pending wakes and dispatches registered actions.
   *
   * @param intervalSeconds - Sleep between ticks (daemon `defaultPollSeconds`
   * is a reasonable ceiling; consumption is independent of watch cadence).
   */
  start(
    workspaceRoot: string,
    intervalSeconds: number,
    options?: WakeConsumeOptions
  ): void;
  /** One pass: claim every currently pending wake, then run actions. */
  tick(
    workspaceRoot: string,
    options?: WakeConsumeOptions
  ): Promise<WakeConsumeTickResult>;
  stop(): void;
}

/**
 * Consumer side of the durable wake inbox (SPEC-PRD-0020-P1 T-06).
 *
 * Each pending wake is claimed via the store's atomic rename; the winner
 * stamps `consumedBy`, then invokes every registered {@link IWakeAction}.
 * Phase 1 registers only the notify mirror. Action failures are recorded on
 * the wake and never move it back to pending — notification is best-effort.
 */
@injectable()
export class WakeConsumptionService implements IWakeConsumptionService {
  private _timer: ReturnType<typeof setTimeout> | null = null;
  private _running = false;

  constructor(
    @inject(WORKFLOW_TOKENS.DaemonStoreRepository)
    private readonly _store: IDaemonStoreRepository,
    @inject(WORKFLOW_TOKENS.WakeActionRegistry)
    private readonly _actions: IWakeActionRegistry
  ) {}

  start(
    workspaceRoot: string,
    intervalSeconds: number,
    options: WakeConsumeOptions = {}
  ): void {
    if (
      Number.isSafeInteger(intervalSeconds) === false ||
      intervalSeconds <= 0
    ) {
      throw new TypeError(
        'Wake consumption intervalSeconds must be a positive integer'
      );
    }
    this.stop();
    this._running = true;
    void this.cycle(workspaceRoot, intervalSeconds, options);
  }

  async tick(
    workspaceRoot: string,
    options: WakeConsumeOptions = {}
  ): Promise<WakeConsumeTickResult> {
    const consumerId =
      typeof options.consumerId === 'string' &&
      options.consumerId.trim().length > 0
        ? options.consumerId.trim()
        : DEFAULT_WAKE_CONSUMER_ID;
    const pending = this._store.listPendingWakes(workspaceRoot);
    const claimed: WakeEvent[] = [];
    const actionFailures: WakeEvent[] = [];

    for (const wake of pending) {
      const won = await this._store.claimWake(workspaceRoot, wake.id);
      if (won === null) {
        continue;
      }
      const recorded = this._store.recordWakeConsumed(
        workspaceRoot,
        won.id,
        consumerId
      );
      claimed.push(recorded);
      const failed = await this.dispatchActions(workspaceRoot, recorded);
      if (failed !== null) {
        actionFailures.push(failed);
      }
    }

    return { claimed, actionFailures };
  }

  stop(): void {
    this._running = false;
    if (this._timer !== null) {
      clearTimeout(this._timer);
      this._timer = null;
    }
  }

  private async cycle(
    workspaceRoot: string,
    intervalSeconds: number,
    options: WakeConsumeOptions
  ): Promise<void> {
    try {
      await this.tick(workspaceRoot, options);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.error(`[wake-consumption] tick failed: ${detail}`);
    }
    if (this._running === false) {
      return;
    }
    this._timer = setTimeout(
      () => void this.cycle(workspaceRoot, intervalSeconds, options),
      Math.max(MINIMUM_CONSUME_TICK_MILLISECONDS, intervalSeconds * 1_000)
    );
  }

  /**
   * Run every registered action after the claim. Failures are durably
   * recorded; they never throw out of the tick and never un-consume the wake.
   */
  private async dispatchActions(
    workspaceRoot: string,
    wake: WakeEvent
  ): Promise<WakeEvent | null> {
    const consumedBy = wake.consumedBy ?? DEFAULT_WAKE_CONSUMER_ID;
    let latest: WakeEvent | null = null;
    for (const action of this._actions.list()) {
      let result;
      try {
        result = await action.execute({
          workspaceRoot,
          wake,
          consumedBy
        });
      } catch (error) {
        latest = this._store.recordWakeActionFailure(workspaceRoot, wake.id, {
          actionId: action.id,
          at: new Date().toISOString(),
          error: error instanceof Error ? error.message : String(error)
        });
        continue;
      }
      if (result.ok === true) {
        continue;
      }
      latest = this._store.recordWakeActionFailure(workspaceRoot, wake.id, {
        actionId: action.id,
        channelId: result.channelId,
        at: new Date().toISOString(),
        error:
          typeof result.error === 'string' && result.error.trim().length > 0
            ? result.error
            : 'action failed without a message'
      });
    }
    return latest;
  }
}
