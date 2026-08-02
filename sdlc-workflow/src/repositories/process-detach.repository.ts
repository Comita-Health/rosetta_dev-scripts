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
}

@injectable()
export class ProcessDetachRepository implements IProcessDetachRepository {
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
