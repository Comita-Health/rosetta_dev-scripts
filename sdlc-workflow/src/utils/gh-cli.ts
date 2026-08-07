import { execSync } from 'child_process';
import { WorkflowError } from '../types';
import { envForAddiWrite } from './gh-auth';

export interface RunGhOptions {
  stdin?: string;
  /**
   * When true, require an Addi GitHub App identity - never fall through to
   * the ambient human gh login.
   */
  requireAddi?: boolean;
}

/**
 * Run a gh CLI command in repoPath.
 *
 * @remarks
 * Mutating calls (requireAddi: true) go through envForAddiWrite so
 * needs-human issues and SDLC PRs are authored by Addi. Read-only calls may
 * use ambient auth.
 */
export const runGh = (
  repoPath: string,
  command: string,
  options: RunGhOptions = {}
): string => {
  const requireAddi = options.requireAddi === true;
  const env = requireAddi
    ? envForAddiWrite(process.env, { cwd: repoPath })
    : { ...process.env };

  try {
    return execSync(command, {
      cwd: repoPath,
      encoding: 'utf-8',
      input: options.stdin,
      env,
      stdio: ['pipe', 'pipe', 'pipe']
    });
  } catch (err) {
    if (err instanceof WorkflowError) {
      throw err;
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new WorkflowError(
      'gh ' + command.split(' ')[1] + ' failed',
      'GH_FAILED',
      [message.slice(0, 1000)]
    );
  }
};
