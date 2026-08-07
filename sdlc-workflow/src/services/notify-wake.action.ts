import { spawnSync } from 'child_process';
import type { WakeEvent } from '../types';
import type {
  IWakeAction,
  WakeActionContext,
  WakeActionResult
} from './wake-action';

export const NOTIFY_WAKE_ACTION_ID = 'notify';

/**
 * One best-effort mirror channel under the Phase 1 notify action.
 *
 * Channels must never require a chat/conversation object. Failures throw so
 * the action can surface them for durable recording without undoing the claim.
 */
export interface IWakeNotificationChannel {
  readonly id: string;
  notify(wake: WakeEvent): Promise<void>;
}

/**
 * Native macOS banner via `osascript`, mirroring `wake-inbox.sh`'s
 * `wake_notify_system`. Missing `osascript` is a no-op (non-macOS hosts);
 * a failed spawn is a recorded failure.
 */
export class DesktopNotificationChannel implements IWakeNotificationChannel {
  readonly id = 'desktop';

  async notify(wake: WakeEvent): Promise<void> {
    const body = (wake.prompt ?? wake.signal).slice(0, 220);
    const escaped = body.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const script = `display notification "${escaped}" with title "SDLC wake: ${wake.kind}" sound name "Ping"`;
    const result = spawnSync('osascript', ['-e', script], {
      encoding: 'utf-8'
    });
    if (
      result.error !== undefined &&
      (result.error as NodeJS.ErrnoException).code === 'ENOENT'
    ) {
      return;
    }
    if (result.status !== 0) {
      const detail =
        (result.stderr ?? '').trim() ||
        (result.error instanceof Error
          ? result.error.message
          : `osascript exited ${String(result.status)}`);
      throw new Error(detail);
    }
  }
}

/**
 * Stdout sentinel mirror (`AGENT_LOOP_WAKE_<kind> …`), the chat
 * `notify_on_output` channel. Writes JSON so a watching agent can parse it;
 * never constructs a conversation object.
 */
export class ChatMirrorNotificationChannel implements IWakeNotificationChannel {
  readonly id = 'chat-mirror';

  constructor(
    private readonly _write: (line: string) => void = line => {
      process.stdout.write(`${line}\n`);
    }
  ) {}

  async notify(wake: WakeEvent): Promise<void> {
    const payload = JSON.stringify({
      id: wake.id,
      kind: wake.kind,
      target: wake.target,
      signal: wake.signal,
      prompt: wake.prompt ?? '',
      data: wake.data ?? {},
      createdAt: wake.createdAt,
      consumedBy: wake.consumedBy
    });
    this._write(`AGENT_LOOP_WAKE_${wake.kind} ${payload}`);
  }
}

/**
 * Phase 1 follow-up action: best-effort chat/desktop notification mirrors.
 *
 * Claim + `consumedBy` already happened before this runs. Channel failures are
 * returned (and later recorded) rather than thrown out of the consumption
 * loop, so a broken banner never re-queues a wake.
 */
export class NotifyWakeAction implements IWakeAction {
  readonly id = NOTIFY_WAKE_ACTION_ID;
  private readonly _channels: readonly IWakeNotificationChannel[];

  constructor(channels?: readonly IWakeNotificationChannel[]) {
    this._channels = channels ?? [
      new DesktopNotificationChannel(),
      new ChatMirrorNotificationChannel()
    ];
  }

  async execute(context: WakeActionContext): Promise<WakeActionResult> {
    const errors: Array<{ channelId: string; error: string }> = [];
    for (const channel of this._channels) {
      try {
        await channel.notify(context.wake);
      } catch (error) {
        errors.push({
          channelId: channel.id,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
    if (errors.length === 0) {
      return { ok: true };
    }
    // Surface the first channel id for structured recording; fold the rest
    // into the message so nothing is silently dropped.
    const [first, ...rest] = errors;
    const detail =
      rest.length === 0
        ? first.error
        : `${errors
            .map(entry => `${entry.channelId}: ${entry.error}`)
            .join('; ')}`;
    return {
      ok: false,
      channelId: first.channelId,
      error: detail
    };
  }
}
