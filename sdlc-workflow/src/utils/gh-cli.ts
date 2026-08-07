import { execSync } from 'child_process';
import { WorkflowError } from '../types';
import { envForAddiWrite, resetAddiTokenCache } from './gh-auth';
import { originSlug } from './gh-repo';

export interface RunGhOptions {
  stdin?: string;
  /**
   * When true, require an Addi GitHub App identity - never fall through to
   * the ambient human gh login.
   */
  requireAddi?: boolean;
}

/**
 * Owner of the checkout's origin, or undefined when it cannot be resolved.
 * A write still has to be attempted in that case: failing auth selection is
 * the caller's problem to report, not a reason to skip the command.
 */
const ownerOf = (repoPath: string): string | undefined => {
  try {
    return originSlug(repoPath).split('/')[0];
  } catch {
    return undefined;
  }
};

/**
 * Message plus stderr for a failed exec.
 *
 * @remarks
 * execSync puts only "Command failed: ..." in `message` and the actual
 * diagnosis in `stderr`, so reading `message` alone throws away the reason -
 * including the 401 this module has to recognise.
 */
const describeExecError = (err: unknown): string => {
  if (!(err instanceof Error)) {
    return String(err);
  }
  const stderr = (err as { stderr?: Buffer | string }).stderr;
  const tail = stderr === undefined ? '' : stderr.toString().trim();
  return [err.message, tail].filter(part => part.length > 0).join('\n');
};

/** How gh reports an expired or revoked token, on both REST and GraphQL. */
const isAuthFailure = (detail: string): boolean =>
  /\b401\b|bad credentials/i.test(detail);

/**
 * Environment for gh calls against a checkout: the workspace App (Addi)
 * identity whenever one can be resolved for the origin's owner.
 *
 * @remarks
 * Reads take the same identity as writes on purpose. Ambient auth in a
 * detached run is whatever token the operator exported at launch, which
 * expires an hour in while the run continues for hours - so read paths
 * (CI polling, PR lookup) would start failing on their own schedule. Going
 * through the same accessor gives the whole run one credential with one
 * refresh policy.
 *
 * A read must still work on a checkout with no App configured, so an
 * unresolvable Addi identity falls back to ambient auth; a write propagates
 * the failure rather than silently acting as the human.
 */
export const ghEnv = (
  repoPath: string,
  requireAddi = false
): NodeJS.ProcessEnv => {
  const owner = ownerOf(repoPath);
  // No origin means no owner to select an App for and nothing to authenticate
  // against. Minting anyway would pick a workspace App by discovery order and
  // spend a round trip to answer a question nobody asked.
  if (owner === undefined && requireAddi === false) {
    return { ...process.env };
  }

  try {
    return envForAddiWrite(process.env, { cwd: repoPath, owner });
  } catch (err) {
    if (requireAddi) {
      throw err;
    }
    return { ...process.env };
  }
};

/**
 * Run a gh CLI command in repoPath.
 *
 * @remarks
 * Mutating calls (requireAddi: true) demand an Addi identity so needs-human
 * issues and SDLC PRs are authored by the App. An auth failure is retried
 * once against a forcibly re-minted token: a credential can expire between
 * the freshness check and the call, and that is indistinguishable from a
 * revoked one until a re-mint settles it. Any other failure is reported as
 * it happened.
 */
export const runGh = (
  repoPath: string,
  command: string,
  options: RunGhOptions = {}
): string => {
  const requireAddi = options.requireAddi === true;
  const attempt = (): string =>
    execSync(command, {
      cwd: repoPath,
      encoding: 'utf-8',
      input: options.stdin,
      env: ghEnv(repoPath, requireAddi),
      stdio: ['pipe', 'pipe', 'pipe']
    });

  const fail = (detail: string): never => {
    throw new WorkflowError(
      'gh ' + command.split(' ')[1] + ' failed',
      'GH_FAILED',
      [detail.slice(0, 1000)]
    );
  };

  try {
    return attempt();
  } catch (err) {
    if (err instanceof WorkflowError) {
      throw err;
    }
    const detail = describeExecError(err);
    if (!isAuthFailure(detail)) {
      return fail(detail);
    }

    resetAddiTokenCache();
    try {
      return attempt();
    } catch (retryErr) {
      if (retryErr instanceof WorkflowError) {
        throw retryErr;
      }
      return fail(describeExecError(retryErr));
    }
  }
};
