import { spawnSync } from 'child_process';
import { injectable } from 'inversify';

export interface ShellCommandResult {
  ok: boolean;
  output: string;
}

/**
 * Executes a repo-declared contract command (sandbox deploy/health, the
 * verification testCommand) in a working directory. Failure is a result,
 * not an exception — contract commands failing is a gate outcome.
 */
export interface IShellCommandRepository {
  run(
    cwd: string,
    command: string,
    env: Record<string, string>,
    timeoutMs: number
  ): ShellCommandResult;
}

const MAX_BUFFER = 32 * 1024 * 1024;

@injectable()
export class ShellCommandRepository implements IShellCommandRepository {
  run(
    cwd: string,
    command: string,
    env: Record<string, string>,
    timeoutMs: number
  ): ShellCommandResult {
    const result = spawnSync(command, {
      shell: true,
      cwd,
      env: { ...process.env, ...env },
      encoding: 'utf-8',
      timeout: timeoutMs,
      maxBuffer: MAX_BUFFER
    });

    const output = [result.stdout ?? '', result.stderr ?? ''].join('\n').trim();
    if (result.error !== undefined) {
      return { ok: false, output: `${result.error.message}\n${output}`.trim() };
    }
    return { ok: result.status === 0, output };
  }
}
