import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync
} from 'fs';
import { injectable } from 'inversify';
import path from 'path';
import { writeFileAtomic } from '../utils/atomic-write';

export interface DaemonProcessStartInput {
  pidFile: string;
  logPath: string;
  /** Override pid for tests; production uses `process.pid`. */
  pid?: number;
}

/**
 * PID-file and signal lifecycle for a single daemon process. No watch/poll
 * logic — bootstrap and exit only (SPEC-PRD-0020-P1 T-01).
 */
export interface IDaemonProcessRepository {
  /**
   * Create the pid/log parent directories and touch the log file so launchd can
   * open StandardOutPath/StandardErrorPath at bootstrap time (install must
   * call this before loading the agent).
   */
  ensureState(
    input: Pick<DaemonProcessStartInput, 'pidFile' | 'logPath'>
  ): void;
  /** Create state dirs, touch the log path, and write the pid file. */
  writePid(input: DaemonProcessStartInput): void;
  /** Read a pid file; `null` when absent or unparseable. */
  readPid(pidFile: string): number | null;
  /** True while the pid responds to signal 0. */
  isAlive(pid: number): boolean;
  /** Remove the pid file if it still names this process (or any, when forced). */
  clearPid(pidFile: string, expectedPid?: number): void;
  /**
   * Block until SIGTERM/SIGINT, then resolve. Used as the daemon's long-run
   * body until later tasks add poll modules.
   */
  waitForShutdown(): Promise<void>;
}

@injectable()
export class DaemonProcessRepository implements IDaemonProcessRepository {
  ensureState(
    input: Pick<DaemonProcessStartInput, 'pidFile' | 'logPath'>
  ): void {
    mkdirSync(path.dirname(input.pidFile), { recursive: true });
    mkdirSync(path.dirname(input.logPath), { recursive: true });
    if (!existsSync(input.logPath)) {
      writeFileSync(input.logPath, '', 'utf-8');
    }
  }

  writePid(input: DaemonProcessStartInput): void {
    this.ensureState(input);
    const pid = input.pid ?? process.pid;
    writeFileAtomic(input.pidFile, `${pid}\n`);
  }

  readPid(pidFile: string): number | null {
    if (!existsSync(pidFile)) {
      return null;
    }
    const raw = readFileSync(pidFile, 'utf-8').trim();
    const pid = Number.parseInt(raw, 10);
    if (Number.isNaN(pid) || pid <= 0) {
      return null;
    }
    return pid;
  }

  isAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  clearPid(pidFile: string, expectedPid?: number): void {
    if (!existsSync(pidFile)) {
      return;
    }
    if (expectedPid !== undefined) {
      const current = this.readPid(pidFile);
      if (current !== expectedPid) {
        return;
      }
    }
    try {
      unlinkSync(pidFile);
    } catch {
      // Race with another clearer — ignore.
    }
  }

  waitForShutdown(): Promise<void> {
    return new Promise(resolve => {
      let settled = false;
      // A signal listener alone does not keep the event loop alive — with
      // stdin ignored (launchd / test spawns) Node would exit 0 immediately
      // after startup. The interval is the keepalive floor; launchd's
      // KeepAlive restarts the process if we still die.
      const keepalive = setInterval(() => {}, 60_000);
      const finish = (): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearInterval(keepalive);
        process.removeListener('SIGTERM', finish);
        process.removeListener('SIGINT', finish);
        resolve();
      };
      process.once('SIGTERM', finish);
      process.once('SIGINT', finish);
    });
  }
}
