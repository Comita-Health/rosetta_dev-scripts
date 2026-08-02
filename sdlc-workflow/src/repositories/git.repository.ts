import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { injectable } from 'inversify';
import { DiffStat, WorkflowError } from '../types';

export interface GitCommitOptions {
  /** Bypass client hooks (husky). Required on `sdlc/*` branches when the
   * target repo only allows `f/*` / `b/*` (#41). */
  noVerify?: boolean;
  /** Append a `Signed-off-by` trailer (DCO). */
  signOff?: boolean;
}

export interface IGitRepository {
  headSha(repoPath: string): string;
  /** `git status --porcelain` output for the primary checkout. */
  status(repoPath: string): string;
  /**
   * Create (or reuse) a worktree at `worktreePath` on `branch`, based at
   * `baseSha`. Idempotent: an existing worktree directory is reused so
   * resume can rediscover in-flight work.
   */
  addWorktree(
    repoPath: string,
    worktreePath: string,
    branch: string,
    baseSha: string
  ): void;
  /** Numstat diff between two refs (added + deleted lines per file). */
  diffStat(repoPath: string, baseRef: string, headRef: string): DiffStat;
  /** Full unified diff text between two refs. */
  diffText(repoPath: string, baseRef: string, headRef: string): string;
  /**
   * Push `branch` to origin from the given checkout (P3 T-02). Idempotent:
   * pushing an already-pushed branch at the same head is a no-op for git.
   */
  push(repoPath: string, branch: string): void;
  /** Fetch origin so remote-tracking refs are current (P3 T-05). */
  fetch(repoPath: string): void;
  /** Resolve any ref (e.g. `origin/main`) to a SHA. */
  resolveSha(repoPath: string, ref: string): string;
  /** The repo's default branch name, from origin/HEAD (fallback: main). */
  defaultBranch(repoPath: string): string;
  /**
   * Revert a merge commit (first-parent mainline) with a signed-off commit
   * in the given checkout (P3 T-05 veto path).
   */
  revertMerge(repoPath: string, sha: string): void;
  /** Stage all changes in the checkout (`git add -A`). */
  stageAll(repoPath: string): void;
  /**
   * Create a commit in the checkout. Engine-owned commits on `sdlc/*`
   * branches pass `{ noVerify: true }` so target-repo husky branch checks
   * cannot block the run (#41).
   */
  commit(repoPath: string, message: string, options?: GitCommitOptions): void;
}

const git = (repoPath: string, args: string): string => {
  try {
    return execSync(`git -C "${repoPath}" ${args}`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe']
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new WorkflowError(`git ${args.split(' ')[0]} failed`, 'GIT_FAILED', [
      message.slice(0, 500)
    ]);
  }
};

@injectable()
export class GitRepository implements IGitRepository {
  headSha(repoPath: string): string {
    return git(repoPath, 'rev-parse HEAD').trim();
  }

  status(repoPath: string): string {
    return git(repoPath, 'status --porcelain');
  }

  addWorktree(
    repoPath: string,
    worktreePath: string,
    branch: string,
    baseSha: string
  ): void {
    if (existsSync(worktreePath)) {
      return;
    }
    git(repoPath, `worktree add -b "${branch}" "${worktreePath}" "${baseSha}"`);
  }

  diffText(repoPath: string, baseRef: string, headRef: string): string {
    return git(repoPath, `diff "${baseRef}".."${headRef}"`);
  }

  push(repoPath: string, branch: string): void {
    git(repoPath, `push -u origin "${branch}"`);
  }

  fetch(repoPath: string): void {
    git(repoPath, 'fetch origin');
  }

  resolveSha(repoPath: string, ref: string): string {
    return git(repoPath, `rev-parse "${ref}"`).trim();
  }

  defaultBranch(repoPath: string): string {
    const prefix = 'refs/remotes/origin/';
    try {
      const ref = git(repoPath, 'symbolic-ref refs/remotes/origin/HEAD').trim();
      // Strip the prefix rather than taking the last path segment: branch
      // names may contain slashes (comita_admissions defaults to
      // `build-env/dev`, which a `.pop()` would truncate to `dev`).
      const name = ref.startsWith(prefix) ? ref.slice(prefix.length) : '';
      return name.length > 0 ? name : 'main';
    } catch {
      return 'main';
    }
  }

  revertMerge(repoPath: string, sha: string): void {
    git(repoPath, `revert --no-edit --signoff -m 1 "${sha}"`);
  }

  stageAll(repoPath: string): void {
    git(repoPath, 'add -A');
  }

  commit(repoPath: string, message: string, options?: GitCommitOptions): void {
    const flags: string[] = [];
    if (options?.noVerify === true) flags.push('--no-verify');
    if (options?.signOff === true) flags.push('--signoff');
    const escaped = message.replace(/"/g, '\\"');
    const flagStr = flags.length > 0 ? `${flags.join(' ')} ` : '';
    git(repoPath, `commit ${flagStr}-m "${escaped}"`);
  }

  diffStat(repoPath: string, baseRef: string, headRef: string): DiffStat {
    const raw = git(repoPath, `diff --numstat "${baseRef}".."${headRef}"`);
    const files: DiffStat['files'] = [];
    let totalLines = 0;
    for (const line of raw.split('\n')) {
      const match = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
      if (!match) continue;
      const added = match[1] === '-' ? 0 : Number(match[1]);
      const deleted = match[2] === '-' ? 0 : Number(match[2]);
      files.push({ path: match[3].trim(), lines: added + deleted });
      totalLines += added + deleted;
    }
    return { files, totalLines };
  }
}
