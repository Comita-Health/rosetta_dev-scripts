import { spawnSync } from 'child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { DaemonConfigRepository } from '../repositories/daemon-config.repository';
import { DaemonStoreRepository } from '../repositories/daemon-store.repository';
import { KnownWatchTargetRepository } from '../repositories/known-watch-target.repository';
import { DaemonStatusService } from '../services/daemon-status.service';
import {
  DEFAULT_POLL_FAILURE_CAP,
  PollSchedulerService
} from '../services/poll-scheduler.service';
import {
  WatchSourceAdapterRegistry,
  type IWatchSourceAdapter
} from '../services/watch-source-adapter';
import { WatchRegistryService } from '../services/watch-registry.service';
import {
  DAEMON_FATAL_EXIT_CODE,
  daemonExitCode,
  exitDaemonFatal
} from '../utils/daemon-exit';
import { pollErrorSignalId } from '../utils/watch-wake-commit';

const CLI = path.resolve(__dirname, '..', 'index.ts');
const PKG = path.resolve(__dirname, '..', '..');

const writeDaemonConfig = (root: string): void => {
  mkdirSync(path.join(root, '.sdlc'), { recursive: true });
  writeFileSync(
    path.join(root, '.sdlc', 'daemon.json'),
    JSON.stringify({
      activateScript: 'scripts/activate.sh',
      runsDir: 'var/runs',
      defaultPollSeconds: 30,
      headlessRunner: 'test-runner'
    }),
    'utf-8'
  );
};

describe('daemon loud-failure semantics (SPEC-PRD-0020-P2 T-04)', () => {
  it('maps only success to exit 0; fatal reasons are non-zero', () => {
    expect(daemonExitCode('success')).toBe(0);
    expect(daemonExitCode('fatal-bootstrap')).toBe(DAEMON_FATAL_EXIT_CODE);
    expect(daemonExitCode('unrecoverable-tick')).toBe(DAEMON_FATAL_EXIT_CODE);
    expect(daemonExitCode('fatal-bootstrap')).not.toBe(0);
    expect(daemonExitCode('unrecoverable-tick')).not.toBe(0);
  });

  it('exitDaemonFatal invokes exit with a non-zero code', () => {
    const exitFn = jest.fn();
    const consoleError = jest
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);

    exitDaemonFatal('fatal-bootstrap', 'config unusable', exitFn);

    expect(exitFn).toHaveBeenCalledWith(1);
    expect(exitFn).not.toHaveBeenCalledWith(0);
    expect(consoleError).toHaveBeenCalledWith(
      '[daemon] fatal-bootstrap: config unusable'
    );
    consoleError.mockRestore();
  });

  it('simulated fatal daemon startup returns a non-zero process exit code', () => {
    const missing = path.join(
      mkdtempSync(path.join(os.tmpdir(), 'daemon-fatal-boot-')),
      'no-such-workspace'
    );
    const result = spawnSync(
      'bunx',
      ['tsx', CLI, 'daemon', '--workspace', missing],
      {
        cwd: PKG,
        encoding: 'utf-8',
        timeout: 30_000,
        env: {
          ...process.env,
          ROSETTA_WAKE_DIR: path.join(path.dirname(missing), 'wake')
        }
      }
    );
    expect(result.status).not.toBe(0);
    expect(result.status).not.toBeNull();
    expect(result.stderr + result.stdout).toMatch(/DAEMON_CONFIG_INVALID/);
  }, 60_000);

  it('force-failed adapter shows degraded watch and poll-error wake in status', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-07T10:00:00.000Z'));
    const workspace = mkdtempSync(
      path.join(os.tmpdir(), 'daemon-loud-status-')
    );
    writeDaemonConfig(workspace);

    const store = new DaemonStoreRepository();
    const watches = new WatchRegistryService(store);
    watches.register(workspace, {
      kind: 'pr-review',
      target: { repo: 'owner/repo', number: 99 },
      pollSeconds: 30,
      createdBy: 'loud-failure-test'
    });
    const adapters = new WatchSourceAdapterRegistry();
    const adapter: IWatchSourceAdapter = {
      poll: jest.fn().mockRejectedValue(new Error('force-failed adapter'))
    };
    adapters.register('pr-review', adapter);
    const scheduler = new PollSchedulerService(watches, store, adapters);

    for (let attempt = 0; attempt < DEFAULT_POLL_FAILURE_CAP; attempt += 1) {
      await scheduler.tick(workspace);
      jest.advanceTimersByTime(30_000);
    }

    const report = new DaemonStatusService(
      new DaemonConfigRepository(),
      watches,
      store,
      new KnownWatchTargetRepository()
    ).build(workspace);

    expect(report.watches).toHaveLength(1);
    expect(report.watches[0]?.degraded).toBe(true);
    expect(report.watches[0]?.lastError).toBe('force-failed adapter');

    const pollError = report.wakes.filter(
      wake =>
        wake.signal === pollErrorSignalId('force-failed adapter') &&
        (wake.state === 'pending' || wake.state === 'consumed')
    );
    expect(pollError).toHaveLength(1);
    expect(pollError[0]?.state).toBe('pending');
    jest.useRealTimers();
  });
});
