import { ChildProcess, spawn } from 'child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync
} from 'fs';
import os from 'os';
import path from 'path';
import {
  DaemonStoreRepository,
  DurableWatchRecord,
  WakeEventInput,
  wakeEventId
} from '../repositories/daemon-store.repository';

const watch: DurableWatchRecord = {
  id: 'pr-review:{"repo":"owner/repo","number":42}',
  kind: 'pr-review',
  target: { repo: 'owner/repo', number: 42 },
  pollSeconds: 30,
  createdBy: 'test',
  createdAt: '2026-08-07T10:00:00.000Z'
};

const wake: WakeEventInput = {
  kind: 'pr-review',
  target: 'owner/repo#42',
  signal: 'approved:review-123',
  createdAt: '2026-08-07T10:01:00.000Z',
  prompt: 'PR approved',
  data: { reviewId: 123 }
};

const waitForReady = (child: ChildProcess): Promise<void> =>
  new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf-8');
    child.stderr?.setEncoding('utf-8');
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
      if (stdout.includes('READY\n') === true) {
        resolve();
      }
    });
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('exit', code => {
      reject(
        new Error(
          `Store writer exited before ready with code ${code}: ${stderr.trim()}`
        )
      );
    });
  });

const storeModulePath = path.resolve(
  __dirname,
  '..',
  'repositories',
  'daemon-store.repository.ts'
);

/**
 * Race `racers` separate processes for one watch's poll lease, releasing them
 * from a gate file so they contend inside the same few milliseconds instead of
 * being serialized by process startup.
 */
const raceForPollLease = async (
  workspace: string,
  watchId: string,
  racers: number
): Promise<({ generation: number; token: string } | null)[]> => {
  const gate = path.join(workspace, 'lease-race-gate');
  const script = `
    const fs = require('fs');
    const { DaemonStoreRepository } = require(${JSON.stringify(storeModulePath)});
    const store = new DaemonStoreRepository();
    process.stdout.write('READY\\n');
    const attempt = () => {
      if (fs.existsSync(process.env.GATE) === false) {
        setImmediate(attempt);
        return;
      }
      const lease = store.tryAcquirePollLease(
        process.env.WORKSPACE,
        process.env.WATCH_ID,
        60_000
      );
      process.stdout.write('RESULT ' + JSON.stringify(lease) + '\\n');
    };
    attempt();
  `;
  const children = Array.from({ length: racers }, () =>
    spawn(process.execPath, ['--import', 'tsx', '--eval', script], {
      cwd: path.resolve(__dirname, '..', '..'),
      env: {
        ...process.env,
        WORKSPACE: workspace,
        WATCH_ID: watchId,
        GATE: gate
      },
      stdio: ['ignore', 'pipe', 'pipe']
    })
  );

  // One stdout listener per child, feeding both the readiness gate and the
  // final output: attaching a second listener later would start the stream
  // flowing before that listener exists and could drop the READY line.
  const races = children.map(child => {
    let stdout = '';
    let stderr = '';
    let ready: (() => void) | undefined;
    const readyPromise = new Promise<void>(resolve => {
      ready = resolve;
    });
    const output = new Promise<string>((resolve, reject) => {
      child.stdout?.setEncoding('utf-8');
      child.stderr?.setEncoding('utf-8');
      child.stdout?.on('data', (chunk: string) => {
        stdout += chunk;
        if (stdout.includes('READY\n') === true) {
          ready?.();
        }
      });
      child.stderr?.on('data', (chunk: string) => {
        stderr += chunk;
      });
      child.once('error', reject);
      child.once('exit', code => {
        if (code === 0) {
          resolve(stdout);
          return;
        }
        reject(new Error(`Lease racer exited ${code}: ${stderr.trim()}`));
      });
    });
    return { ready: readyPromise, output };
  });

  await Promise.all(races.map(race => race.ready));
  writeFileSync(gate, '');
  const outputs = races.map(race => race.output);

  return (await Promise.all(outputs)).map(stdout => {
    const line = stdout
      .split('\n')
      .find(candidate => candidate.startsWith('RESULT '));
    if (line === undefined) {
      throw new Error(`Lease racer produced no result: ${stdout}`);
    }
    return JSON.parse(line.slice('RESULT '.length));
  });
};

describe('DaemonStoreRepository', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('survives writer process death and reopens identical records', async () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), 'daemon-store-kill-'));
    const modulePath = path.resolve(
      __dirname,
      '..',
      'repositories',
      'daemon-store.repository.ts'
    );
    // `require`, matching the CommonJS this package actually emits: the module
    // exports no default, and resolving a named export out of an ESM `import`
    // of a transpiled `.ts` fails outright. The explicit constructor check
    // keeps any future interop change loud instead of leaving a child that
    // reaches READY without ever writing a record.
    const script = `
      const { DaemonStoreRepository } = require(${JSON.stringify(modulePath)});
      if (typeof DaemonStoreRepository !== 'function') {
        throw new TypeError('DaemonStoreRepository did not load as a constructor');
      }
      const store = new DaemonStoreRepository();
      store.writeWatch(process.env.WORKSPACE, ${JSON.stringify(watch)});
      store.writeWake(process.env.WORKSPACE, ${JSON.stringify(wake)});
      process.stdout.write('READY\\n');
      setInterval(() => {}, 1_000);
    `;
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', '--eval', script],
      {
        cwd: path.resolve(__dirname, '..', '..'),
        env: { ...process.env, WORKSPACE: workspace },
        stdio: ['ignore', 'pipe', 'pipe']
      }
    );

    const reopened = new DaemonStoreRepository();
    expect(existsSync(reopened.paths(workspace).root)).toBe(false);

    let signal: NodeJS.Signals | null = null;
    try {
      await waitForReady(child);
    } finally {
      const exited = new Promise<NodeJS.Signals | null>(resolve => {
        child.once('exit', (_code, exitSignal) => resolve(exitSignal));
      });
      child.kill('SIGKILL');
      signal = await exited;
    }

    // Nothing in the writer got a chance to flush on the way out, so anything
    // readable now was made durable by the writes themselves.
    expect(signal).toBe('SIGKILL');
    expect(reopened.readWatch(workspace, watch.id)).toEqual(watch);
    expect(reopened.readWake(workspace, wakeEventId(wake))).toEqual({
      id: wakeEventId(wake),
      ...wake
    });
    expect(reopened.listWatches(workspace)).toEqual([watch]);
    expect(reopened.listPendingWakes(workspace)).toEqual([
      { id: wakeEventId(wake), ...wake }
    ]);
  });

  it('isolates records in physically distinct workspace directories', () => {
    const leftRoot = mkdtempSync(path.join(os.tmpdir(), 'daemon-store-left-'));
    const rightRoot = mkdtempSync(
      path.join(os.tmpdir(), 'daemon-store-right-')
    );
    const store = new DaemonStoreRepository();

    store.writeWatch(leftRoot, watch);
    store.writeWake(leftRoot, wake);

    expect(store.paths(leftRoot).root).not.toBe(store.paths(rightRoot).root);
    expect(existsSync(store.paths(leftRoot).root)).toBe(true);
    expect(existsSync(store.paths(rightRoot).root)).toBe(false);
    writeFileSync(path.join(store.paths(leftRoot).watches, 'ignored.tmp'), '');
    expect(store.listWatches(leftRoot)).toEqual([watch]);
    expect(store.listWatches(rightRoot)).toEqual([]);
    expect(store.listPendingWakes(rightRoot)).toEqual([]);
    expect(store.readWatch(rightRoot, watch.id)).toBeNull();
    expect(store.readWake(rightRoot, wakeEventId(wake))).toBeNull();
  });

  it('deduplicates wake writes by kind, target, and signal', () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), 'daemon-store-once-'));
    const store = new DaemonStoreRepository();
    const first = store.writeWake(workspace, wake);
    const replay = store.writeWake(workspace, {
      ...wake,
      createdAt: '2026-08-07T10:02:00.000Z',
      prompt: 'duplicate detection'
    });

    expect(first.created).toBe(true);
    expect(replay.created).toBe(false);
    expect(replay.record).toEqual(first.record);
    expect(readdirSync(store.paths(workspace).pendingWakes)).toHaveLength(1);
  });

  it('exclusively acquires, safely releases, and expires poll leases', () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-07T10:00:00.000Z'));
    const workspace = mkdtempSync(
      path.join(os.tmpdir(), 'daemon-store-lease-')
    );
    const store = new DaemonStoreRepository();
    const first = store.tryAcquirePollLease(workspace, watch.id, 1_000);

    expect(first).not.toBeNull();
    expect(store.tryAcquirePollLease(workspace, watch.id, 1_000)).toBeNull();
    store.releasePollLease(workspace, {
      ...first!,
      token: 'not-the-owner'
    });
    expect(store.tryAcquirePollLease(workspace, watch.id, 1_000)).toBeNull();

    jest.advanceTimersByTime(1_000);
    const recovered = store.tryAcquirePollLease(workspace, watch.id, 1_000);
    expect(recovered).not.toBeNull();
    expect(recovered?.token).not.toBe(first?.token);
    // Recovery takes the *next* generation rather than re-creating the name it
    // observed, which is what keeps it from removing a successor's lease.
    expect(recovered?.generation).toBe(first!.generation + 1);
    store.releasePollLease(workspace, first!);
    expect(store.tryAcquirePollLease(workspace, watch.id, 1_000)).toBeNull();
    store.releasePollLease(workspace, recovered!);
    expect(() => store.tryAcquirePollLease(workspace, watch.id, 0)).toThrow(
      /positive integer/
    );
    expect(
      store.tryAcquirePollLease(workspace, watch.id, 1_000)
    ).not.toBeNull();
  });

  it('lets exactly one of several concurrent expiry recoveries hold the lease', async () => {
    const workspace = mkdtempSync(
      path.join(os.tmpdir(), 'daemon-store-lease-race-')
    );
    const store = new DaemonStoreRepository();
    // A lease abandoned by a crashed poll: expired, still on disk.
    const abandoned = store.tryAcquirePollLease(workspace, watch.id, 1);
    expect(abandoned).not.toBeNull();
    await new Promise(resolve => setTimeout(resolve, 10));

    const results = await raceForPollLease(workspace, watch.id, 4);
    const winners = results.filter(lease => lease !== null);

    // Recovery must add a generation, never remove the file it observed:
    // a recovery that unlinked the expired lease and re-created it would let
    // a second recovery unlink the successor and hand out a second lease.
    expect(winners).toHaveLength(1);
    expect(winners[0]?.generation).toBeGreaterThan(abandoned!.generation);
    expect(readdirSync(store.paths(workspace).pollLeases)).toHaveLength(1);

    // The crashed holder returning late cannot remove the successor either.
    store.releasePollLease(workspace, abandoned!);
    expect(readdirSync(store.paths(workspace).pollLeases)).toHaveLength(1);
    expect(store.tryAcquirePollLease(workspace, watch.id, 1_000)).toBeNull();
  }, 60_000);

  it('allows exactly one of two concurrent atomic-rename claims to win', async () => {
    const workspace = mkdtempSync(
      path.join(os.tmpdir(), 'daemon-store-claim-')
    );
    const store = new DaemonStoreRepository();
    const written = store.writeWake(workspace, wake).record;

    const claims = await Promise.all([
      store.claimWake(workspace, written.id),
      store.claimWake(workspace, written.id)
    ]);

    expect(claims.filter(record => record !== null)).toEqual([written]);
    expect(store.listPendingWakes(workspace)).toEqual([]);
    expect(store.readWake(workspace, written.id)).toEqual(written);
    const claimedFiles = readdirSync(store.paths(workspace).consumedWakes);
    expect(claimedFiles).toEqual([`${written.id}.json`]);
    expect(
      JSON.parse(
        readFileSync(
          path.join(store.paths(workspace).consumedWakes, claimedFiles[0]),
          'utf-8'
        )
      )
    ).toEqual(written);
    expect(store.writeWake(workspace, wake)).toEqual({
      record: written,
      created: false
    });
  });

  it('never re-queues a consumed wake when its signal is detected again', async () => {
    const workspace = mkdtempSync(
      path.join(os.tmpdir(), 'daemon-store-replay-')
    );
    const store = new DaemonStoreRepository();
    const written = store.writeWake(workspace, wake).record;
    expect(await store.claimWake(workspace, written.id)).toEqual(written);

    const redetected = store.writeWake(workspace, {
      ...wake,
      createdAt: '2026-08-07T11:00:00.000Z',
      prompt: 'same signal, later poll'
    });

    expect(redetected).toEqual({ record: written, created: false });
    expect(readdirSync(store.paths(workspace).pendingWakes)).toEqual([]);
    expect(await store.claimWake(workspace, written.id)).toBeNull();
    expect(readdirSync(store.paths(workspace).consumedWakes)).toEqual([
      `${written.id}.json`
    ]);
    expect(store.readWake(workspace, written.id)).toEqual(written);
  });

  it('refuses to claim again when a pending file reappears beside a consumed one', async () => {
    const workspace = mkdtempSync(
      path.join(os.tmpdir(), 'daemon-store-double-')
    );
    const store = new DaemonStoreRepository();
    const paths = store.paths(workspace);
    const written = store.writeWake(workspace, wake).record;
    expect(await store.claimWake(workspace, written.id)).toEqual(written);

    // The state writeWake can never produce, planted by hand: a pending file
    // for an ID that is already consumed. A rename would silently replace the
    // consumed record and hand out a second claim.
    const consumedFile = path.join(paths.consumedWakes, `${written.id}.json`);
    copyFileSync(
      consumedFile,
      path.join(paths.pendingWakes, `${written.id}.json`)
    );

    expect(await store.claimWake(workspace, written.id)).toBeNull();
    expect(existsSync(consumedFile)).toBe(true);
    expect(JSON.parse(readFileSync(consumedFile, 'utf-8'))).toEqual(written);
  });

  it('rejects claim filesystem failures without losing the pending wake', async () => {
    const workspace = mkdtempSync(
      path.join(os.tmpdir(), 'daemon-store-error-')
    );
    const store = new DaemonStoreRepository();
    const written = store.writeWake(workspace, wake).record;
    const consumed = store.paths(workspace).consumedWakes;
    chmodSync(consumed, 0o500);

    try {
      await expect(
        store.claimWake(workspace, written.id)
      ).rejects.toMatchObject({ code: 'EACCES' });
    } finally {
      chmodSync(consumed, 0o700);
    }
    expect(store.listPendingWakes(workspace)).toEqual([written]);
    expect(await store.claimWake(workspace, written.id)).toEqual(written);
  });

  it('hashes an unambiguous tuple and rejects empty roots and IDs', () => {
    expect(wakeEventId({ kind: 'ab', target: 'c', signal: 'd' })).not.toBe(
      wakeEventId({ kind: 'a', target: 'bc', signal: 'd' })
    );

    const store = new DaemonStoreRepository();
    expect(() => store.paths('')).toThrow(/non-empty workspace root/);
    expect(() => store.writeWatch(os.tmpdir(), { ...watch, id: '' })).toThrow(
      /record ID must be non-empty/
    );
    expect(() => store.readWake(os.tmpdir(), '../unsafe')).toThrow(
      /wake ID must be a SHA-256 digest/
    );
  });

  it('stamps consumedBy onto the shared ledger inode after a claim', async () => {
    const workspace = mkdtempSync(
      path.join(os.tmpdir(), 'daemon-store-consumed-by-')
    );
    const store = new DaemonStoreRepository();
    const written = store.writeWake(workspace, wake).record;
    expect(await store.claimWake(workspace, written.id)).toEqual(written);

    const updated = store.recordWakeConsumed(workspace, written.id, 'daemon');
    expect(updated.consumedBy).toBe('daemon');
    expect(store.readWake(workspace, written.id)?.consumedBy).toBe('daemon');
    const consumedPath = path.join(
      store.paths(workspace).consumedWakes,
      `${written.id}.json`
    );
    expect(JSON.parse(readFileSync(consumedPath, 'utf-8')).consumedBy).toBe(
      'daemon'
    );
  });

  it('appends actionFailures without clearing consumedBy', async () => {
    const workspace = mkdtempSync(
      path.join(os.tmpdir(), 'daemon-store-action-fail-')
    );
    const store = new DaemonStoreRepository();
    const written = store.writeWake(workspace, wake).record;
    await store.claimWake(workspace, written.id);
    store.recordWakeConsumed(workspace, written.id, 'daemon');

    const failed = store.recordWakeActionFailure(workspace, written.id, {
      actionId: 'notify',
      channelId: 'desktop',
      at: '2026-08-07T12:00:01.000Z',
      error: 'banner exploded'
    });

    expect(failed.consumedBy).toBe('daemon');
    expect(failed.actionFailures).toEqual([
      {
        actionId: 'notify',
        channelId: 'desktop',
        at: '2026-08-07T12:00:01.000Z',
        error: 'banner exploded'
      }
    ]);
  });

  it('appends further failures after the first and omits a blank channel', () => {
    const workspace = mkdtempSync(
      path.join(os.tmpdir(), 'daemon-store-action-fail-append-')
    );
    const store = new DaemonStoreRepository();
    const written = store.writeWake(workspace, wake).record;

    store.recordWakeActionFailure(workspace, written.id, {
      actionId: ' notify ',
      at: '2026-08-07T12:00:01.000Z',
      error: 'banner exploded'
    });
    const second = store.recordWakeActionFailure(workspace, written.id, {
      actionId: 'notify',
      channelId: '   ',
      at: '',
      error: '  pipe closed  '
    });

    expect(second.actionFailures).toHaveLength(2);
    expect(second.actionFailures?.[0]).toEqual({
      actionId: 'notify',
      at: '2026-08-07T12:00:01.000Z',
      error: 'banner exploded'
    });
    expect(second.actionFailures?.[1]).toEqual({
      actionId: 'notify',
      // An absent timestamp is stamped at record time rather than dropped.
      at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      error: 'pipe closed'
    });
    expect(store.readWake(workspace, written.id)?.actionFailures).toHaveLength(
      2
    );
  });

  it('rejects consumption and failure records the loop must never write', () => {
    const workspace = mkdtempSync(
      path.join(os.tmpdir(), 'daemon-store-record-guards-')
    );
    const store = new DaemonStoreRepository();
    const written = store.writeWake(workspace, wake).record;
    const unknownId = 'b'.repeat(64);

    expect(() => store.recordWakeConsumed(workspace, written.id, '  ')).toThrow(
      TypeError
    );
    expect(() =>
      store.recordWakeConsumed(
        workspace,
        written.id,
        undefined as unknown as string
      )
    ).toThrow(/non-empty string/);
    expect(() =>
      store.recordWakeConsumed(workspace, unknownId, 'daemon')
    ).toThrow(`Cannot record consumption for unknown wake ${unknownId}`);

    expect(() =>
      store.recordWakeActionFailure(workspace, written.id, {
        actionId: ' ',
        at: '2026-08-07T12:00:01.000Z',
        error: 'banner exploded'
      })
    ).toThrow(/non-empty actionId/);
    expect(() =>
      store.recordWakeActionFailure(workspace, written.id, {
        actionId: undefined as unknown as string,
        at: '2026-08-07T12:00:01.000Z',
        error: 'banner exploded'
      })
    ).toThrow(/non-empty actionId/);
    expect(() =>
      store.recordWakeActionFailure(workspace, written.id, {
        actionId: 'notify',
        at: '2026-08-07T12:00:01.000Z',
        error: '   '
      })
    ).toThrow(/non-empty error/);
    expect(() =>
      store.recordWakeActionFailure(workspace, written.id, {
        actionId: 'notify',
        at: '2026-08-07T12:00:01.000Z',
        error: undefined as unknown as string
      })
    ).toThrow(/non-empty error/);
    expect(() =>
      store.recordWakeActionFailure(workspace, unknownId, {
        actionId: 'notify',
        at: '2026-08-07T12:00:01.000Z',
        error: 'banner exploded'
      })
    ).toThrow(`Cannot record action failure for unknown wake ${unknownId}`);

    expect(store.readWake(workspace, written.id)).toEqual(written);
  });

  it('overwrites cleanly when the in-place rewrite shrinks the record', () => {
    const workspace = mkdtempSync(
      path.join(os.tmpdir(), 'daemon-store-shrink-')
    );
    const store = new DaemonStoreRepository();
    const written = store.writeWake(workspace, {
      ...wake,
      prompt: 'x'.repeat(500)
    }).record;

    store.recordWakeConsumed(workspace, written.id, 'daemon');
    const shortened = store.recordWakeConsumed(workspace, written.id, 'd');
    const ledgerPath = path.join(
      store.paths(workspace).wakeRecords,
      `${written.id}.json`
    );

    expect(shortened.consumedBy).toBe('d');
    // A truncating rewrite must not leave trailing bytes behind.
    expect(JSON.parse(readFileSync(ledgerPath, 'utf-8'))).toEqual(shortened);
  });
});
