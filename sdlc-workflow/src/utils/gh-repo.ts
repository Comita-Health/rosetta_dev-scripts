import { execSync } from 'child_process';
import { WorkflowError } from '../types';

const SSH_FORM = /^git@[^:]+:(?<slug>[^/]+\/[^/]+?)(?:\.git)?$/;
const HTTPS_FORM = /^https?:\/\/[^/]+\/(?<slug>[^/]+\/[^/]+?)(?:\.git)?$/;

const cache = new Map<string, string>();

/**
 * The `owner/repo` slug of a checkout's `origin` remote.
 *
 * @remarks
 * Every `gh` call the engine makes must pin `--repo` to this value. When the
 * checkout is a fork, an unqualified `gh pr create` / `gh issue create`
 * resolves against the fork's *upstream parent* rather than `origin`. The
 * engine always pushes task branches to `origin`, so the unqualified call
 * looks for a branch in a repository it was never pushed to and fails with
 * `No commits between main and <branch>` / `Head ref must be a branch` —
 * wording that reads like a bad branch rather than a wrong-repository
 * lookup, and that no amount of gate remediation can fix.
 *
 * Resolved once per checkout: a remote URL does not change mid-run, and the
 * `gh` calls this feeds are on the per-task hot path.
 *
 * @throws {WorkflowError} `GH_FAILED` when `origin` is absent or its URL is
 * not a recognizable GitHub remote — failing loudly beats silently letting
 * `gh` pick a repository the caller did not intend.
 */
export const originSlug = (repoPath: string): string => {
  const cached = cache.get(repoPath);
  if (cached !== undefined) {
    return cached;
  }

  let url: string;
  try {
    url = execSync('git remote get-url origin', {
      cwd: repoPath,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe']
    }).trim();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new WorkflowError(
      `cannot resolve the origin remote for ${repoPath}`,
      'GH_FAILED',
      [message.slice(0, 500)]
    );
  }

  const slug = (SSH_FORM.exec(url) ?? HTTPS_FORM.exec(url))?.groups?.slug;
  if (slug === undefined) {
    throw new WorkflowError(
      `origin remote for ${repoPath} is not a GitHub remote`,
      'GH_FAILED',
      [url.slice(0, 200)]
    );
  }

  cache.set(repoPath, slug);
  return slug;
};

/** Drop a checkout's memoized slug. Test seam; run worktrees are stable. */
export const clearOriginSlugCache = (): void => {
  cache.clear();
};
