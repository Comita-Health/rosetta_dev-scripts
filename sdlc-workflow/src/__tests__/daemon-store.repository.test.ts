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
  id: 'pr-review:owner/repo#42',
  kind: 'pr-review',
  target: 'owner/repo#42',
  pollSeconds: 30,
  creator: 'test',
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

describe('DaemonStoreRepository', () => {
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
});
