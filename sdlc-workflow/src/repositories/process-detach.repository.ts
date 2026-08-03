import { spawn, type ChildProcess } from 'child_process';
import { openSync } from 'fs';
import { injectable } from 'inversify';

export interface DetachSpawnInput {
  /** Absolute or PATH-resolved executable (usually `process.execPath`). */
  command: string;
  args: string[];
  /** Directory for the child `cwd`. */
  cwd: string;
  /** Append-only log file for child stdout+stderr. */
  logPath: string;
  env?: NodeJS.ProcessEnv;
}

export interface DetachSpawnResult {
  pid: number;
}

/**
 * Spawns a long-running child that survives the parent exiting — required so
 * agent/IDE shell teardown cannot reap `sdlc-workflow run` (live-val #38).
 *
 * Uses Node `detached: true` + `unref()` and file-backed stdio (not inherit).
 * @see https://nodejs.org/api/child_process.html#optionsdetached
 */
export interface IProcessDetachRepository {
  spawnDetached(input: DetachSpawnInput): DetachSpawnResult;
  /** True while the pid is still running (signal 0 probe). */
  isAlive(pid: number): boolean;
}

@injectable()
export class ProcessDetachRepository implements IProcessDetachRepository {
  isAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  spawnDetached(input: DetachSpawnInput): DetachSpawnResult {
    const logFd = openSync(input.logPath, 'a');
    const child: ChildProcess = spawn(input.command, input.args, {
      cwd: input.cwd,
      env: input.env ?? process.env,
      detached: true,
      stdio: ['ignore', logFd, logFd]
    });
    if (child.pid === undefined) {
      throw new Error('detached spawn produced no pid');
    }
    child.unref();
    return { pid: child.pid };
  }
}
