import { mkdtempSync, readdirSync } from 'fs';
import os from 'os';
import path from 'path';
import {
  DaemonStoreRepository,
  WakeWriteResult
} from '../repositories/daemon-store.repository';
import {
  PollSchedulerService,
  DEFAULT_POLL_FAILURE_CAP
} from '../services/poll-scheduler.service';
import {
  IWatchSourceAdapter,
  WatchSourceAdapterRegistry,
  WatchSourcePollResult
} from '../services/watch-source-adapter';
import { WatchRegistryService } from '../services/watch-registry.service';

const signalResult: WatchSourcePollResult = {
  signals: [
    {
      id: 'review-123:APPROVED',
      observedAt: '2026-08-07T10:00:05.000Z',
      prompt: 'PR approved',
      data: { reviewId: 123 }
    }
  ]
};

const deferred = <T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} => {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>(resolve => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: value => {
      if (resolvePromise === undefined) {
        throw new Error('Deferred promise was not initialized');
      }
      resolvePromise(value);
    }
  };
};

const setup = (
  adapter: IWatchSourceAdapter,
  store: DaemonStoreRepository = new DaemonStoreRepository(),
  pollSeconds = 30
): {
  workspace: string;
  store: DaemonStoreRepository;
  watches: WatchRegistryService;
  adapters: WatchSourceAdapterRegistry;
  scheduler: PollSchedulerService;
} => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), 'poll-scheduler-'));
  const watches = new WatchRegistryService(store);
  watches.register(workspace, {
    kind: 'pr-review',
    target: { repo: 'owner/repo', number: 42 },
    pollSeconds,
    createdBy: 'test'
  });
  const adapters = new WatchSourceAdapterRegistry();
  adapters.register('pr-review', adapter);
  return {
    workspace,
    store,
    watches,
    adapters,
    scheduler: new PollSchedulerService(watches, store, adapters)
  };
};

describe('PollSchedulerService', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-07T10:00:00.000Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('commits one wake when two ticks overlap on the same signal', async () => {
    const pending = deferred<WatchSourcePollResult>();
    const adapter: IWatchSourceAdapter = {
      poll: jest.fn().mockReturnValue(pending.promise)
    };
    const { workspace, store, scheduler } = setup(adapter);

    const firstTick = scheduler.tick(workspace);
    expect(adapter.poll).toHaveBeenCalledTimes(1);
    await scheduler.tick(workspace);
    expect(adapter.poll).toHaveBeenCalledTimes(1);

    pending.resolve(signalResult);
    await firstTick;

    expect(store.listPendingWakes(workspace)).toHaveLength(1);
    expect(readdirSync(store.paths(workspace).wakeRecords)).toHaveLength(1);
  });

  it('deduplicates a source event retried after a crash-like mid-write error', async () => {
    class CrashAfterWriteStore extends DaemonStoreRepository {
      private _crash = true;

      override writeWake(
        workspaceRoot: string,
        input: Parameters<DaemonStoreRepository['writeWake']>[1]
      ): WakeWriteResult {
        const result = super.writeWake(workspaceRoot, input);
        if (this._crash === true) {
          this._crash = false;
          throw new Error('simulated crash after durable wake write');
        }
        return result;
      }
    }

    const adapter: IWatchSourceAdapter = {
      poll: jest.fn().mockResolvedValue(signalResult)
    };
    const { workspace, store, watches, scheduler } = setup(
      adapter,
      new CrashAfterWriteStore()
    );

    await scheduler.tick(workspace);
    expect(watches.list(workspace)[0]).toMatchObject({
      consecutiveFailures: 1,
      lastError: 'simulated crash after durable wake write'
    });

    jest.advanceTimersByTime(30_000);
    await scheduler.tick(workspace);

    expect(adapter.poll).toHaveBeenCalledTimes(2);
    expect(store.listPendingWakes(workspace)).toHaveLength(1);
    expect(readdirSync(store.paths(workspace).wakeRecords)).toHaveLength(1);
    expect(watches.list(workspace)[0]).toMatchObject({
      consecutiveFailures: 0,
      lastError: null,
      degradedAt: null
    });
  });

  it('marks a watch degraded at the failure cap and stops polling it', async () => {
    const adapter: IWatchSourceAdapter = {
      poll: jest.fn().mockRejectedValue(new Error('source unavailable'))
    };
    const { workspace, watches, scheduler } = setup(adapter);

    for (let attempt = 0; attempt < DEFAULT_POLL_FAILURE_CAP; attempt += 1) {
      await scheduler.tick(workspace);
      jest.advanceTimersByTime(30_000);
    }

    expect(adapter.poll).toHaveBeenCalledTimes(DEFAULT_POLL_FAILURE_CAP);
    expect(watches.list(workspace)[0]).toMatchObject({
      consecutiveFailures: DEFAULT_POLL_FAILURE_CAP,
      lastError: 'source unavailable',
      degradedAt: '2026-08-07T10:01:00.000Z'
    });

    await scheduler.tick(workspace);
    jest.advanceTimersByTime(30_000);
    await scheduler.tick(workspace);
    expect(adapter.poll).toHaveBeenCalledTimes(DEFAULT_POLL_FAILURE_CAP);
  });

  it('starts immediately, honors cadence, and stops its timer', async () => {
    const adapter: IWatchSourceAdapter = {
      poll: jest.fn().mockResolvedValue({ signals: [] })
    };
    const { workspace, scheduler } = setup(adapter);

    expect(() => scheduler.start(workspace, 0)).toThrow(/positive integer/);
    expect(() => scheduler.start(workspace, 0.5)).toThrow(/positive integer/);
    scheduler.start(workspace, 30);
    await jest.advanceTimersByTimeAsync(0);
    expect(adapter.poll).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(29_999);
    expect(adapter.poll).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(adapter.poll).toHaveBeenCalledTimes(2);

    scheduler.stop();
    await jest.advanceTimersByTimeAsync(30_000);
    expect(adapter.poll).toHaveBeenCalledTimes(2);
  });

  it('evaluates a watch whose cadence is shorter than the tick ceiling', async () => {
    const adapter: IWatchSourceAdapter = {
      poll: jest.fn().mockResolvedValue({ signals: [] })
    };
    const { workspace, scheduler } = setup(
      adapter,
      new DaemonStoreRepository(),
      5
    );

    scheduler.start(workspace, 30);
    await jest.advanceTimersByTimeAsync(0);
    expect(adapter.poll).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(5_000);
    expect(adapter.poll).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(5_000);
    expect(adapter.poll).toHaveBeenCalledTimes(3);

    scheduler.stop();
  });

  it('skips a kind with no adapter instead of degrading its watches', async () => {
    expect(new WatchSourceAdapterRegistry().get('issue-state')).toBeNull();
    const consoleError = jest
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const configured = setup({
      poll: jest.fn().mockResolvedValue({ signals: [] })
    });
    const empty = new WatchSourceAdapterRegistry();
    const scheduler = new PollSchedulerService(
      configured.watches,
      configured.store,
      empty
    );

    for (let attempt = 0; attempt <= DEFAULT_POLL_FAILURE_CAP; attempt += 1) {
      await scheduler.tick(configured.workspace);
      jest.advanceTimersByTime(30_000);
    }

    expect(configured.watches.list(configured.workspace)[0]).toMatchObject({
      consecutiveFailures: 0,
      lastError: null,
      degradedAt: null
    });
    expect(consoleError).toHaveBeenCalledTimes(1);

    // A running loop over an empty registry polls nothing at all, and says so
    // once rather than on every tick.
    scheduler.start(configured.workspace, 30);
    await jest.advanceTimersByTimeAsync(90_000);
    expect(configured.watches.list(configured.workspace)[0]).toMatchObject({
      consecutiveFailures: 0,
      degradedAt: null
    });
    expect(consoleError).toHaveBeenCalledTimes(2);

    // Registering an adapter later starts polling that same healthy watch.
    const adapter: IWatchSourceAdapter = {
      poll: jest.fn().mockResolvedValue(signalResult)
    };
    empty.register('pr-review', adapter);
    expect(empty.kinds()).toEqual(['pr-review']);
    await jest.advanceTimersByTimeAsync(30_000);
    scheduler.stop();

    expect(adapter.poll).toHaveBeenCalledTimes(1);
    expect(
      configured.store.listPendingWakes(configured.workspace)
    ).toHaveLength(1);
    consoleError.mockRestore();
  });

  it('does not rearm its timer when stopped mid-tick', async () => {
    const pending = deferred<WatchSourcePollResult>();
    const adapter: IWatchSourceAdapter = {
      poll: jest.fn().mockReturnValue(pending.promise)
    };
    const { workspace, scheduler } = setup(
      adapter,
      new DaemonStoreRepository(),
      5
    );

    scheduler.start(workspace, 30);
    await jest.advanceTimersByTimeAsync(0);
    expect(adapter.poll).toHaveBeenCalledTimes(1);

    scheduler.stop();
    pending.resolve({ signals: [] });
    await jest.advanceTimersByTimeAsync(60_000);
    expect(adapter.poll).toHaveBeenCalledTimes(1);
  });

  it('skips a watch whose adapter disappears after the lease is taken', async () => {
    const adapter: IWatchSourceAdapter = {
      poll: jest.fn().mockResolvedValue(signalResult)
    };
    const configured = setup(adapter);
    const racing = {
      kinds: jest.fn().mockReturnValue(['pr-review']),
      get: jest.fn().mockReturnValueOnce(adapter).mockReturnValue(null)
    };
    const scheduler = new PollSchedulerService(
      configured.watches,
      configured.store,
      racing
    );

    await scheduler.tick(configured.workspace);

    expect(adapter.poll).not.toHaveBeenCalled();
    expect(configured.watches.list(configured.workspace)[0]).toMatchObject({
      consecutiveFailures: 0,
      degradedAt: null
    });
    // The lease is released, so the next tick can still poll the watch.
    expect(
      configured.store.tryAcquirePollLease(
        configured.workspace,
        configured.watches.list(configured.workspace)[0].id,
        1_000
      )
    ).not.toBeNull();
  });

  it('publishes a watched Approve as a wake within one poll interval', async () => {
    let approved = false;
    const adapter: IWatchSourceAdapter = {
      poll: jest
        .fn()
        .mockImplementation(async () =>
          approved ? signalResult : { signals: [] }
        )
    };
    const { workspace, store, scheduler } = setup(
      adapter,
      new DaemonStoreRepository(),
      5
    );

    scheduler.start(workspace, 30);
    await jest.advanceTimersByTimeAsync(0);
    expect(store.listPendingWakes(workspace)).toEqual([]);

    approved = true;
    await jest.advanceTimersByTimeAsync(5_000);
    scheduler.stop();

    const wakes = store.listPendingWakes(workspace);
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toMatchObject({
      kind: 'pr-review',
      signal: 'review-123:APPROVED',
      prompt: 'PR approved'
    });
  });

  it('records malformed signals as bounded failures', async () => {
    const malformedAdapter: IWatchSourceAdapter = {
      poll: jest
        .fn()
        .mockResolvedValueOnce({
          signals: [{ id: ' ', observedAt: '2026-08-07T10:00:00.000Z' }]
        })
        .mockResolvedValueOnce({
          signals: [{ id: 'event-1', observedAt: 'not-a-date' }]
        })
    };
    const malformed = setup(malformedAdapter);
    await malformed.scheduler.tick(malformed.workspace);
    jest.advanceTimersByTime(30_000);
    await malformed.scheduler.tick(malformed.workspace);
    expect(malformed.watches.list(malformed.workspace)[0]).toMatchObject({
      consecutiveFailures: 2,
      lastError: 'Watch source signal observedAt must be an ISO timestamp'
    });
  });

  it('publishes a signal without optional prompt or data', async () => {
    const adapter: IWatchSourceAdapter = {
      poll: jest.fn().mockResolvedValue({
        signals: [
          {
            id: 'review-124:DISMISSED',
            observedAt: '2026-08-07T10:00:05.000Z'
          }
        ]
      })
    };
    const { workspace, store, scheduler } = setup(adapter);

    await scheduler.tick(workspace);

    const wakes = store.listPendingWakes(workspace);
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toMatchObject({
      kind: 'pr-review',
      signal: 'review-124:DISMISSED',
      createdAt: '2026-08-07T10:00:05.000Z'
    });
    expect(wakes[0]).not.toHaveProperty('prompt');
    expect(wakes[0]).not.toHaveProperty('data');
  });

  it('rechecks cadence after acquiring the lease', async () => {
    const store = new DaemonStoreRepository();
    const adapter: IWatchSourceAdapter = {
      poll: jest.fn().mockResolvedValue({ signals: [] })
    };
    const configured = setup(adapter, store);
    const originalAcquire = store.tryAcquirePollLease.bind(store);
    jest.spyOn(store, 'tryAcquirePollLease').mockImplementation((...args) => {
      const lease = originalAcquire(...args);
      configured.watches.recordPollFailure(
        configured.workspace,
        args[1],
        new Error('concurrent failure'),
        1
      );
      return lease;
    });

    await configured.scheduler.tick(configured.workspace);

    expect(adapter.poll).not.toHaveBeenCalled();
    expect(store.listPendingWakes(configured.workspace)).toEqual([]);
  });

  it('logs top-level timer errors without creating an unhandled rejection', async () => {
    const adapter: IWatchSourceAdapter = {
      poll: jest.fn().mockResolvedValue({ signals: [] })
    };
    const configured = setup(adapter);
    jest.spyOn(configured.watches, 'list').mockImplementation(() => {
      throw new Error('registry unreadable');
    });
    const consoleError = jest
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);

    configured.scheduler.start(configured.workspace, 30);
    await jest.advanceTimersByTimeAsync(0);
    configured.scheduler.stop();

    expect(consoleError).toHaveBeenCalledWith(
      '[poll-scheduler] tick failed: registry unreadable'
    );
    consoleError.mockRestore();
  });

  it('logs non-Error timer failures', async () => {
    const adapter: IWatchSourceAdapter = {
      poll: jest.fn().mockResolvedValue({ signals: [] })
    };
    const configured = setup(adapter);
    jest.spyOn(configured.watches, 'list').mockImplementation(() => {
      throw 'registry unavailable';
    });
    const consoleError = jest
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);

    configured.scheduler.start(configured.workspace, 30);
    await jest.advanceTimersByTimeAsync(0);
    configured.scheduler.stop();

    expect(consoleError).toHaveBeenCalledWith(
      '[poll-scheduler] tick failed: registry unavailable'
    );
    consoleError.mockRestore();
  });
});
