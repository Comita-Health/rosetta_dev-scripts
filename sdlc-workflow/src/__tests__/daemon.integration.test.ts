import { spawn, spawnSync } from 'child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync
} from 'fs';
import os from 'os';
import path from 'path';

/**
 * Integration: two workspace roots → two live daemon processes with
 * distinct PID files and log paths (SPEC-PRD-0020-P1 T-01).
 */
const CLI = path.resolve(__dirname, '..', 'index.ts');
const PKG = path.resolve(__dirname, '..', '..');
const TSX = path.resolve(PKG, 'node_modules', 'tsx', 'dist', 'cli.mjs');

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

const pidPathFor = (root: string): string =>
  path.join(root, '.sdlc', 'daemon', 'daemon.pid');
const logPathFor = (root: string): string =>
  path.join(root, '.sdlc', 'daemon', 'daemon.log');

const waitForPidFile = async (
  file: string,
  timeoutMs: number
): Promise<number> => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (existsSync(file)) {
      const raw = readFileSync(file, 'utf-8').trim();
      const pid = Number.parseInt(raw, 10);
      if (!Number.isNaN(pid) && pid > 0) {
        try {
          process.kill(pid, 0);
          return pid;
        } catch {
          // Pid file written but process not yet observable — retry.
        }
      }
    }
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for pid file ${file}`);
};

const killPid = (pid: number): void => {
  for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
    try {
      process.kill(pid, signal);
    } catch {
      return;
    }
  }
};

const waitUntilDead = async (pid: number, timeoutMs: number): Promise<void> => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise(r => setTimeout(r, 50));
  }
  killPid(pid);
};

describe('daemon process isolation (integration)', () => {
  it('spawns two daemons with distinct pid files and log paths', async () => {
    const a = mkdtempSync(path.join(os.tmpdir(), 'daemon-int-a-'));
    const b = mkdtempSync(path.join(os.tmpdir(), 'daemon-int-b-'));
    writeDaemonConfig(a);
    writeDaemonConfig(b);

    const spawnDaemon = (workspace: string): void => {
      const child = spawn(
        process.execPath,
        [TSX, CLI, 'daemon', '--workspace', workspace],
        {
          cwd: PKG,
          env: { ...process.env },
          stdio: 'ignore',
          // Detach + unref so Jest's event loop is not pinned to the child.
          detached: true
        }
      );
      child.unref();
    };

    spawnDaemon(a);
    spawnDaemon(b);

    let pidA = 0;
    let pidB = 0;
    try {
      pidA = await waitForPidFile(pidPathFor(a), 15_000);
      pidB = await waitForPidFile(pidPathFor(b), 15_000);

      expect(pidA).not.toBe(pidB);
      expect(pidPathFor(a)).not.toBe(pidPathFor(b));
      expect(logPathFor(a)).not.toBe(logPathFor(b));
      expect(existsSync(logPathFor(a))).toBe(true);
      expect(existsSync(logPathFor(b))).toBe(true);
      expect(readFileSync(pidPathFor(a), 'utf-8').trim()).toBe(String(pidA));
      expect(readFileSync(pidPathFor(b), 'utf-8').trim()).toBe(String(pidB));
    } finally {
      if (pidA > 0) {
        killPid(pidA);
        await waitUntilDead(pidA, 5_000);
      }
      if (pidB > 0) {
        killPid(pidB);
        await waitUntilDead(pidB, 5_000);
      }
    }
  }, 60_000);

  it('fails fast without --workspace and writes no partial state', () => {
    const probe = mkdtempSync(path.join(os.tmpdir(), 'daemon-nofail-'));
    const before = readdirSync(probe);

    const result = spawnSync(process.execPath, [TSX, CLI, 'daemon'], {
      cwd: PKG,
      encoding: 'utf-8',
      env: { ...process.env },
      timeout: 30_000
    });

    expect(result.status).not.toBe(0);
    expect(result.status).not.toBeNull();
    expect(readdirSync(probe)).toEqual(before);
    expect(existsSync(path.join(probe, '.sdlc', 'daemon'))).toBe(false);
  }, 60_000);
});
