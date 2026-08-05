import { execSync, spawn } from 'child_process';
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
  /**
   * SHA of the *tree* a ref points at — what the commit would deploy, with
   * no history, author or message in it (SPEC-PRD-0022-P1 T-01).
   *
   * @remarks
   * This is the deploy-dedup key. A merge commit's SHA always differs from the
   * PR head it merged, but a fast-forward-equivalent merge produces the same
   * tree, so commit-SHA comparison reports "not deployed" for content that is
   * already live and pays for the deploy twice.
   */
  treeSha(repoPath: string, ref: string): string;
  /**
   * Repo-relative paths of every tracked and untracked-but-not-ignored file
   * in the checkout — the tree envelope grounding runs against (#35).
   */
  listFiles(repoPath: string): string[];
  /** The repo's default branch name, from origin/HEAD (fallback: main). */
  defaultBranch(repoPath: string): string;
  /**
   * Contents of a repo-relative path at a ref, or null when the ref does not
   * carry that path (unmerged spec, deleted file, unknown ref).
   */
  fileAtRef(repoPath: string, ref: string, relPath: string): string | null;
  /**
   * True when the working-tree copy of `relPath` differs from the one at
   * `ref`. Catches uncommitted edits and committed-but-unmerged ones alike.
   */
  pathDiffersFromRef(repoPath: string, ref: string, relPath: string): boolean;
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
  /**
   * Dispatch `git worktree remove` for a completed task and return without
   * waiting for it to finish. A stale worktree is disk-space debt, not a
   * correctness problem, so removal must never block or fail the caller —
   * a locked file or a shell still `cd`-ed into the directory only logs a
   * warning. Never call this before the task's work has actually landed
   * (merged or otherwise finalized): a worktree still holds the only copy
   * of an unmerged branch's checkout.
   */
  removeWorktreeAsync(repoPath: string, worktreePath: string): void;
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

  treeSha(repoPath: string, ref: string): string {
    return git(repoPath, `rev-parse "${ref}^{tree}"`).trim();
  }

  listFiles(repoPath: string): string[] {
    const raw = git(repoPath, 'ls-files --cached --others --exclude-standard');
    return raw
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0);
  }

  defaultBranch(repoPath: string): string {
    const prefix = 'refs/remotes/origin/';
    try {
      const ref = git(repoPath, 'symbolic-ref refs/remotes/origin/HEAD').trim();
      // Strip the prefix rather than taking the last path segment: branch
      // names may contain slashes (e.g. `build-env/dev`, which a `.pop()`
      // would truncate to `dev`).
      const name = ref.startsWith(prefix) ? ref.slice(prefix.length) : '';
      return name.length > 0 ? name : 'main';
    } catch {
      return 'main';
    }
  }

  fileAtRef(repoPath: string, ref: string, relPath: string): string | null {
    try {
      return git(repoPath, `show "${ref}:${relPath}"`);
    } catch {
      // `git show` exits non-zero for an unknown ref and for a path the ref
      // does not carry. Both mean "not present there", which the caller
      // treats the same way.
      return null;
    }
  }

  pathDiffersFromRef(repoPath: string, ref: string, relPath: string): boolean {
    try {
      git(repoPath, `diff --quiet "${ref}" -- "${relPath}"`);
      return false;
    } catch {
      // `--quiet` exits 1 on any difference. A genuine git error also lands
      // here and is reported as a difference, which fails closed.
      return true;
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

  removeWorktreeAsync(repoPath: string, worktreePath: string): void {
    if (!existsSync(worktreePath)) return;
    const child = spawn(
      'git',
      ['-C', repoPath, 'worktree', 'remove', '--force', worktreePath],
      { stdio: ['ignore', 'ignore', 'pipe'] }
    );
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf-8');
    });
    child.on('error', err => {
      console.warn(
        `[worktree-cleanup] failed to spawn removal for ${worktreePath}: ${err.message}`
      );
    });
    child.on('close', code => {
      if (code !== 0) {
        console.warn(
          `[worktree-cleanup] git worktree remove exited ${code} for ` +
            `${worktreePath}: ${stderr.trim().slice(0, 300)}`
        );
      }
    });
    // Never lets a background daemon's process wait on this child at exit —
    // fire-and-forget means the cleanup outlives interest in its outcome.
    child.unref();
  }

  diffStat(repoPath: string, baseRef: string, headRef: string): DiffStat {
    const raw = git(
      repoPath,
      `diff --numstat --no-renames "${baseRef}".."${headRef}"`
    );
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
