import { mkdtempSync, readdirSync } from 'fs';
import os from 'os';
import path from 'path';
import {
  DaemonStoreRepository,
  type IDaemonStoreRepository
} from '../repositories/daemon-store.repository';
import type { WakeEvent, WakeEventInput } from '../types';
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
import {
  DEFAULT_WAKE_CONSUMER_ID,
  MINIMUM_CONSUME_TICK_MILLISECONDS,
  WakeConsumptionService
} from '../services/wake-consumption.service';

const wakeInput = (signal: string): WakeEventInput => ({
  kind: 'pr-review',
  target: 'owner/repo#42',
  signal,
  createdAt: '2026-08-07T12:00:00.000Z',
  prompt: 'PR approved',
  data: { reviewId: 1 }
});

/** Only the four store methods the consumption loop actually reaches. */
const stubStore = (
  overrides: Partial<IDaemonStoreRepository> = {}
): IDaemonStoreRepository =>
  ({
    listPendingWakes: jest.fn().mockReturnValue([]),
    claimWake: jest.fn().mockResolvedValue(null),
    recordWakeConsumed: jest.fn(),
    recordWakeActionFailure: jest.fn(),
    ...overrides
  }) as unknown as IDaemonStoreRepository;

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

  it.each([
    ['no options at all', undefined],
    ['a blank consumerId', { consumerId: '   ' }]
  ])('stamps the default consumer id given %s', async (_label, options) => {
    const { workspace, store, consumer } = setup();
    const { record } = store.writeWake(workspace, wakeInput('approved:5'));

    const result = await consumer.tick(workspace, options);

    expect(result.claimed[0].consumedBy).toBe(DEFAULT_WAKE_CONSUMER_ID);
    expect(store.readWake(workspace, record.id)?.consumedBy).toBe(
      DEFAULT_WAKE_CONSUMER_ID
    );
  });

  it('skips a pending wake that another consumer claimed first', async () => {
    const { workspace, store, consumer } = setup();
    store.writeWake(workspace, wakeInput('approved:6'));
    const claim = jest.spyOn(store, 'claimWake').mockResolvedValue(null);
    const consumed = jest.spyOn(store, 'recordWakeConsumed');

    const result = await consumer.tick(workspace);

    expect(claim).toHaveBeenCalled();
    expect(consumed).not.toHaveBeenCalled();
    expect(result).toEqual({ claimed: [], actionFailures: [] });
  });

  it('records an action that throws instead of returning a result', async () => {
    const action: IWakeAction = {
      id: 'explodes',
      execute: async () => {
        throw new Error('dispatch exploded');
      }
    };
    const { workspace, store, consumer } = setup([action]);
    const { record } = store.writeWake(workspace, wakeInput('approved:7'));

    const result = await consumer.tick(workspace);

    expect(result.claimed).toHaveLength(1);
    expect(result.actionFailures).toHaveLength(1);
    const durable = store.readWake(workspace, record.id);
    expect(durable?.consumedBy).toBe(DEFAULT_WAKE_CONSUMER_ID);
    expect(durable?.actionFailures).toEqual([
      expect.objectContaining({
        actionId: 'explodes',
        error: 'dispatch exploded'
      })
    ]);
    expect(durable?.actionFailures?.[0]).not.toHaveProperty('channelId');
  });

  it('records a non-Error thrown by an action', async () => {
    const action: IWakeAction = {
      id: 'rejects',
      execute: async () => {
        throw 'plain string failure';
      }
    };
    const { workspace, store, consumer } = setup([action]);
    const { record } = store.writeWake(workspace, wakeInput('approved:8'));

    await consumer.tick(workspace);

    expect(store.readWake(workspace, record.id)?.actionFailures).toEqual([
      expect.objectContaining({ error: 'plain string failure' })
    ]);
  });

  it('substitutes a message for a failure reported without one', async () => {
    const action: IWakeAction = {
      id: 'quiet',
      execute: async () => ({ ok: false, error: '   ' })
    };
    const { workspace, store, consumer } = setup([action]);
    const { record } = store.writeWake(workspace, wakeInput('approved:9'));

    await consumer.tick(workspace);

    expect(store.readWake(workspace, record.id)?.actionFailures).toEqual([
      expect.objectContaining({
        actionId: 'quiet',
        error: 'action failed without a message'
      })
    ]);
  });

  it('reports only the wakes whose actions failed, not the ones that passed', async () => {
    const action: IWakeAction = {
      id: 'selective',
      execute: async context =>
        context.wake.signal === 'approved:11'
          ? { ok: false, error: 'nope' }
          : { ok: true }
    };
    const { workspace, store, consumer } = setup([action]);
    store.writeWake(workspace, wakeInput('approved:10'));
    const failing = store.writeWake(workspace, wakeInput('approved:11')).record;

    const result = await consumer.tick(workspace);

    expect(result.claimed).toHaveLength(2);
    expect(result.actionFailures.map(wake => wake.id)).toEqual([failing.id]);
  });

  it('falls back to the default consumer id when the stored wake has none', async () => {
    const pending: WakeEvent = {
      id: 'b'.repeat(64),
      kind: 'pr-review',
      target: 'owner/repo#42',
      signal: 'approved:12',
      createdAt: '2026-08-07T12:00:00.000Z'
    };
    const seen: WakeActionContext[] = [];
    const registry = new WakeActionRegistry();
    registry.register({
      id: 'probe',
      execute: async context => {
        seen.push(context);
        return { ok: true };
      }
    });
    const store = stubStore({
      listPendingWakes: jest.fn().mockReturnValue([pending]),
      claimWake: jest.fn().mockResolvedValue(pending),
      // A store that never stamped consumedBy must not crash dispatch.
      recordWakeConsumed: jest.fn().mockReturnValue(pending)
    });

    await new WakeConsumptionService(store, registry).tick('/tmp/workspace');

    expect(seen[0].consumedBy).toBe(DEFAULT_WAKE_CONSUMER_ID);
  });
});

describe('WakeConsumptionService loop control', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it.each([0, -1, 1.5, Number.NaN])(
    'refuses to arm the loop on interval %p',
    interval => {
      const consumer = new WakeConsumptionService(
        stubStore(),
        new WakeActionRegistry()
      );

      expect(() => consumer.start('/tmp/workspace', interval)).toThrow(
        TypeError
      );
    }
  );

  it('ticks immediately and then on the configured interval until stopped', async () => {
    const list = jest.fn().mockReturnValue([]);
    const consumer = new WakeConsumptionService(
      stubStore({ listPendingWakes: list }),
      new WakeActionRegistry()
    );

    consumer.start('/tmp/workspace', 5, { consumerId: 'daemon' });
    await jest.advanceTimersByTimeAsync(0);
    expect(list).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(4_999);
    expect(list).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(1);
    expect(list).toHaveBeenCalledTimes(2);

    consumer.stop();
    await jest.advanceTimersByTimeAsync(20_000);
    expect(list).toHaveBeenCalledTimes(2);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('holds the tick floor for a one-second interval', async () => {
    const list = jest.fn().mockReturnValue([]);
    const consumer = new WakeConsumptionService(
      stubStore({ listPendingWakes: list }),
      new WakeActionRegistry()
    );

    consumer.start('/tmp/workspace', 1);
    await jest.advanceTimersByTimeAsync(MINIMUM_CONSUME_TICK_MILLISECONDS - 1);
    expect(list).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(1);
    expect(list).toHaveBeenCalledTimes(2);

    consumer.stop();
  });

  it('re-arms a fresh loop when start is called twice', async () => {
    const list = jest.fn().mockReturnValue([]);
    const consumer = new WakeConsumptionService(
      stubStore({ listPendingWakes: list }),
      new WakeActionRegistry()
    );

    consumer.start('/tmp/workspace', 5);
    await jest.advanceTimersByTimeAsync(0);
    consumer.start('/tmp/workspace', 5);
    await jest.advanceTimersByTimeAsync(0);
    expect(list).toHaveBeenCalledTimes(2);

    await jest.advanceTimersByTimeAsync(5_000);
    expect(list).toHaveBeenCalledTimes(3);

    consumer.stop();
  });

  it('is safe to stop a loop that was never started', () => {
    const consumer = new WakeConsumptionService(
      stubStore(),
      new WakeActionRegistry()
    );

    expect(() => consumer.stop()).not.toThrow();
  });

  it.each([
    ['an Error', new Error('store unreadable'), 'store unreadable'],
    ['a non-Error', 'store unreadable', 'store unreadable']
  ])(
    'logs %s from a failed tick and keeps ticking',
    async (_label, thrown, expected) => {
      const list = jest.fn().mockImplementationOnce(() => {
        throw thrown;
      });
      list.mockReturnValue([]);
      const error = jest.spyOn(console, 'error').mockImplementation(() => {});
      const consumer = new WakeConsumptionService(
        stubStore({ listPendingWakes: list }),
        new WakeActionRegistry()
      );

      consumer.start('/tmp/workspace', 5);
      await jest.advanceTimersByTimeAsync(0);
      const logged = error.mock.calls.map(call => String(call[0]));
      await jest.advanceTimersByTimeAsync(5_000);
      consumer.stop();
      error.mockRestore();

      expect(logged).toEqual([`[wake-consumption] tick failed: ${expected}`]);
      expect(list).toHaveBeenCalledTimes(2);
    }
  );

  it('does not schedule another tick when stopped mid-tick', async () => {
    const consumer = new WakeConsumptionService(
      stubStore({
        listPendingWakes: jest.fn().mockImplementation(() => {
          consumer.stop();
          return [];
        })
      }),
      new WakeActionRegistry()
    );

    consumer.start('/tmp/workspace', 5);
    await jest.advanceTimersByTimeAsync(0);

    expect(jest.getTimerCount()).toBe(0);
  });
});
