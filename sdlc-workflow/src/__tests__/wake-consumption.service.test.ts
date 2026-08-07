import { mkdtempSync, readdirSync } from 'fs';
import os from 'os';
import path from 'path';
import { DaemonStoreRepository } from '../repositories/daemon-store.repository';
import type { WakeEventInput } from '../types';
import {
  ChatMirrorNotificationChannel,
  NotifyWakeAction,
  type IWakeNotificationChannel
} from '../services/notify-wake.action';
import {
  WakeActionRegistry,
  type IWakeAction,
  type WakeActionContext
} from '../services/wake-action';
import { WakeConsumptionService } from '../services/wake-consumption.service';

const wakeInput = (signal: string): WakeEventInput => ({
  kind: 'pr-review',
  target: 'owner/repo#42',
  signal,
  createdAt: '2026-08-07T12:00:00.000Z',
  prompt: 'PR approved',
  data: { reviewId: 1 }
});

const setup = (
  actions: IWakeAction[] = []
): {
  workspace: string;
  store: DaemonStoreRepository;
  registry: WakeActionRegistry;
  consumer: WakeConsumptionService;
} => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), 'wake-consume-'));
  const store = new DaemonStoreRepository();
  const registry = new WakeActionRegistry();
  for (const action of actions) {
    registry.register(action);
  }
  return {
    workspace,
    store,
    registry,
    consumer: new WakeConsumptionService(store, registry)
  };
};

describe('WakeConsumptionService (SPEC-PRD-0020-P1 T-06)', () => {
  it('claims a wake atomically so two concurrent consumers cannot both win', async () => {
    const { workspace, store } = setup();
    const { record } = store.writeWake(workspace, wakeInput('approved:1'));
    const left = new WakeConsumptionService(store, new WakeActionRegistry());
    const right = new WakeConsumptionService(store, new WakeActionRegistry());

    const [a, b] = await Promise.all([
      left.tick(workspace, { consumerId: 'consumer-a' }),
      right.tick(workspace, { consumerId: 'consumer-b' })
    ]);

    const winners = [...a.claimed, ...b.claimed];
    expect(winners).toHaveLength(1);
    expect(winners[0].id).toBe(record.id);
    expect(store.listPendingWakes(workspace)).toEqual([]);
    expect(readdirSync(store.paths(workspace).consumedWakes)).toEqual([
      `${record.id}.json`
    ]);
    const durable = store.readWake(workspace, record.id);
    expect(
      durable?.consumedBy === 'consumer-a' ||
        durable?.consumedBy === 'consumer-b'
    ).toBe(true);
  });

  it('records the consumer in consumedBy after a successful claim', async () => {
    const { workspace, store, consumer } = setup();
    const { record } = store.writeWake(workspace, wakeInput('approved:2'));

    const result = await consumer.tick(workspace, {
      consumerId: 'daemon-test'
    });

    expect(result.claimed).toHaveLength(1);
    expect(result.claimed[0].consumedBy).toBe('daemon-test');
    expect(store.readWake(workspace, record.id)?.consumedBy).toBe(
      'daemon-test'
    );
  });

  it('marks the wake consumed when a notification channel fails and records the failure', async () => {
    const failing: IWakeNotificationChannel = {
      id: 'desktop',
      notify: async () => {
        throw new Error('banner exploded');
      }
    };
    const lines: string[] = [];
    const action = new NotifyWakeAction([
      failing,
      new ChatMirrorNotificationChannel(line => {
        lines.push(line);
      })
    ]);
    const { workspace, store, consumer } = setup([action]);
    const { record } = store.writeWake(workspace, wakeInput('approved:3'));

    const result = await consumer.tick(workspace, {
      consumerId: 'daemon'
    });

    expect(result.claimed).toHaveLength(1);
    expect(result.claimed[0].consumedBy).toBe('daemon');
    expect(result.actionFailures).toHaveLength(1);
    expect(store.listPendingWakes(workspace)).toEqual([]);
    const durable = store.readWake(workspace, record.id);
    expect(durable?.consumedBy).toBe('daemon');
    expect(durable?.actionFailures).toEqual([
      expect.objectContaining({
        actionId: 'notify',
        channelId: 'desktop',
        error: expect.stringContaining('banner exploded')
      })
    ]);
    // The other mirror channel still ran — failure is per-channel, not abort.
    expect(
      lines.some(line => line.startsWith('AGENT_LOOP_WAKE_pr-review'))
    ).toBe(true);
  });

  it('accepts a registered action without constructing or passing any chat or conversation object', async () => {
    const seen: WakeActionContext[] = [];
    const action: IWakeAction = {
      id: 'probe',
      execute: async context => {
        seen.push(context);
        return { ok: true };
      }
    };
    const { workspace, store, consumer } = setup([action]);
    store.writeWake(workspace, wakeInput('approved:4'));

    await consumer.tick(workspace, { consumerId: 'cli' });

    expect(seen).toHaveLength(1);
    expect(Object.keys(seen[0]).sort()).toEqual([
      'consumedBy',
      'wake',
      'workspaceRoot'
    ]);
    expect(seen[0]).not.toHaveProperty('chat');
    expect(seen[0]).not.toHaveProperty('conversation');
    expect(seen[0]).not.toHaveProperty('session');
    expect(seen[0]).not.toHaveProperty('thread');
    expect(seen[0].consumedBy).toBe('cli');
    expect(seen[0].workspaceRoot).toBe(workspace);
  });
});
