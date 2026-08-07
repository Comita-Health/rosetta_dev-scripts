import { injectable } from 'inversify';
import type { WakeEvent } from '../types';

/**
 * Durable context handed to a follow-up action (SPEC-PRD-0020-P1 T-06).
 *
 * Deliberately free of chat/session/conversation objects: registration and
 * dispatch must survive a dead editor session, and Phase 3 headless agent
 * dispatch plugs into the same shape without inventing a second path.
 */
export interface WakeActionContext {
  workspaceRoot: string;
  wake: WakeEvent;
  /** Consumer id already stamped onto the wake (`daemon`, `cli`, …). */
  consumedBy: string;
}

export interface WakeActionResult {
  ok: boolean;
  /** Human-readable failure; ignored when `ok` is true. */
  error?: string;
  /** Optional channel that failed inside a multi-channel action. */
  channelId?: string;
}

/**
 * Registered follow-up invoked after a wake is claimed and `consumedBy` is set.
 *
 * Phase 1 ships only the notify action; Phase 3 headless dispatch implements
 * this same interface and registers beside it — no consumption-engine rework.
 */
export interface IWakeAction {
  readonly id: string;
  execute(context: WakeActionContext): Promise<WakeActionResult>;
}

/** Late-bound action lookup keeps the consumption loop transport-agnostic. */
export interface IWakeActionRegistry {
  register(action: IWakeAction): void;
  get(id: string): IWakeAction | null;
  list(): IWakeAction[];
}

/**
 * Mutable composition registry populated at process start.
 *
 * The daemon owns one singleton. Phase 1 registers the notify mirror; Phase 3
 * adds headless dispatch without changing the consumption loop.
 */
@injectable()
export class WakeActionRegistry implements IWakeActionRegistry {
  private readonly _actions = new Map<string, IWakeAction>();

  register(action: IWakeAction): void {
    if (typeof action.id !== 'string' || action.id.trim().length === 0) {
      throw new TypeError('Wake action id must be a non-empty string');
    }
    this._actions.set(action.id, action);
  }

  get(id: string): IWakeAction | null {
    return this._actions.get(id) ?? null;
  }

  list(): IWakeAction[] {
    return [...this._actions.values()];
  }
}
