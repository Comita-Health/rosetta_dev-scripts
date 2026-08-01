import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { injectable } from 'inversify';
import { DiffStat, WorkflowError } from '../types';

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
