import { spawn } from 'child_process';
import { injectable } from 'inversify';

export interface ShellCommandResult {
  ok: boolean;
  output: string;
}

/**
 * Executes a repo-declared contract command (sandbox deploy/health, the
 * verification testCommand) in a working directory. Failure is a result,
 * not an exception — contract commands failing is a gate outcome.
 *
 * Async (`spawn`, not `spawnSync`): a synchronous exec blocks Node's single
 * thread for the command's full duration, which made it impossible for the
 * sandbox deploy and the verification test-tier to ever overlap even when
 * the orchestrator awaited them concurrently — they physically could not
 * run at the same time in one process. `spawn` lets independent contract
 * commands run in parallel via `Promise.all`.
 */
export interface IShellCommandRepository {
  run(
    cwd: string,
    command: string,
    env: Record<string, string>,
    timeoutMs: number
  ): Promise<ShellCommandResult>;
}

const MAX_BUFFER = 32 * 1024 * 1024;

@injectable()
export class ShellCommandRepository implements IShellCommandRepository {
  run(
    cwd: string,
    command: string,
    env: Record<string, string>,
    timeoutMs: number
  ): Promise<ShellCommandResult> {
    return new Promise(resolve => {
      const child = spawn(command, {
        shell: true,
        cwd,
        env: { ...process.env, ...env }
      });

      let output = '';
      let truncated = false;
      let timedOut = false;
      let settled = false;

      const append = (chunk: Buffer): void => {
        if (truncated) return;
        output += chunk.toString('utf-8');
        if (output.length > MAX_BUFFER) {
          output = output.slice(0, MAX_BUFFER);
          truncated = true;
        }
      };
      child.stdout?.on('data', append);
      child.stderr?.on('data', append);

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
      }, timeoutMs);

      const settle = (ok: boolean, extra?: string): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({
          ok,
          output: [extra, output].filter(Boolean).join('\n').trim()
        });
      };

      child.on('error', err => settle(false, err.message));
      child.on('close', code => {
        settle(!timedOut && code === 0);
      });
    });
  }
}
