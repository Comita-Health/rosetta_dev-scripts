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
  store: DaemonStoreRepository = new DaemonStoreRepository()
): {
  workspace: string;
  store: DaemonStoreRepository;
  watches: WatchRegistryService;
  scheduler: PollSchedulerService;
} => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), 'poll-scheduler-'));
  const watches = new WatchRegistryService(store);
  watches.register(workspace, {
    kind: 'pr-review',
    target: { repo: 'owner/repo', number: 42 },
    pollSeconds: 30,
    createdBy: 'test'
  });
  const adapters = new WatchSourceAdapterRegistry();
  adapters.register('pr-review', adapter);
  return {
    workspace,
    store,
    watches,
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

  it('records missing adapters and malformed signals as bounded failures', async () => {
    expect(new WatchSourceAdapterRegistry().get('issue-state')).toBeNull();
    const missingAdapter = {
      get: jest.fn().mockReturnValue(null)
    };
    const missingSetup = setup({
      poll: jest.fn().mockResolvedValue({ signals: [] })
    });
    const missingScheduler = new PollSchedulerService(
      missingSetup.watches,
      missingSetup.store,
      missingAdapter
    );

    await missingScheduler.tick(missingSetup.workspace);
    expect(missingSetup.watches.list(missingSetup.workspace)[0]).toMatchObject({
      consecutiveFailures: 1,
      lastError: 'No source adapter registered for pr-review'
    });

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
});
