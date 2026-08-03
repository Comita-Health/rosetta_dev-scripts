import { execSync } from 'child_process';
import { injectable } from 'inversify';
import { WorkflowError } from '../types';

export interface PrRef {
  url: string;
  number: number;
}

/**
 * GitHub pull-request operations via the operator's `gh` session (P3 T-02)
 * — the same operator-auth pattern as `ci-status`. Resource access only:
 * idempotency and title/body composition live in the PR-lifecycle service.
 */
export interface IPullRequestRepository {
  /** The open PR whose head is `branch`, or null when none exists. */
  findByBranch(repoPath: string, branch: string): PrRef | null;
  create(
    repoPath: string,
    input: { branch: string; title: string; body: string }
  ): PrRef;
  /**
   * Merge the PR (P3 T-04) and return the merge commit SHA. Only ever called
   * by the enforcement path when every gate is green. The method matches
   * `addi-merge-on-approve.yml` so engine merges and Approve-driven merges
   * cannot leave a repo with two different histories: GitHub native stacks
   * go through `merge-async` with merge commits, everything else squashes.
   */
  merge(repoPath: string, number: number): Promise<string>;
  /** Post an issue-style comment on the PR (reviewer overview surface). */
  comment(repoPath: string, number: number, body: string): void;
}

const MERGE_ASYNC_TIMEOUT_MS = 10 * 60_000;
const MERGE_ASYNC_POLL_MS = 5_000;

const sleep = (ms: number): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, ms));

const gh = (repoPath: string, command: string, stdin?: string): string => {
  try {
    return execSync(command, {
      cwd: repoPath,
      encoding: 'utf-8',
      input: stdin,
      stdio: ['pipe', 'pipe', 'pipe']
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new WorkflowError(`gh ${command.split(' ')[1]} failed`, 'GH_FAILED', [
      message.slice(0, 1000)
    ]);
  }
};

@injectable()
export class PullRequestRepository implements IPullRequestRepository {
  findByBranch(repoPath: string, branch: string): PrRef | null {
    const raw = gh(
      repoPath,
      `gh pr list --head "${branch}" --state open --json url,number --limit 1`
    );
    let refs: PrRef[];
    try {
      refs = JSON.parse(raw);
    } catch {
      throw new WorkflowError(
        'gh pr list returned unparseable JSON',
        'GH_FAILED',
        [raw.slice(0, 500)]
      );
    }
    return refs.length > 0 ? refs[0] : null;
  }

  create(
    repoPath: string,
    input: { branch: string; title: string; body: string }
  ): PrRef {
    // Body via stdin (--body-file -) so Markdown survives shell quoting.
    const url = gh(
      repoPath,
      `gh pr create --head "${input.branch}" --title "${input.title.replace(/"/g, '\\"')}" --body-file -`,
      input.body
    ).trim();
    const match = url.match(/\/pull\/(\d+)\s*$/);
    if (match === null) {
      throw new WorkflowError(
        'gh pr create did not return a PR URL',
        'GH_FAILED',
        [url.slice(0, 500)]
      );
    }
    return { url, number: Number(match[1]) };
  }

  async merge(repoPath: string, number: number): Promise<string> {
    try {
      if (this.isStacked(repoPath, number)) {
        await this.mergeStack(repoPath, number);
      } else {
        // No `--delete-branch`: the engine only ever merges a branch that is
        // checked out in one of its own worktrees, so gh's local delete always
        // fails — after the merge has already landed. The repo sets
        // delete_branch_on_merge, so the remote branch is reaped anyway.
        gh(repoPath, `gh pr merge ${number} --squash`);
      }
    } catch (err) {
      // gh exits non-zero for post-merge cleanup problems too, so a thrown
      // error does not prove the merge failed. Reporting a landed merge as a
      // failure is the costly direction: it escalates a needs-human issue,
      // holds the phase gate behind a task that is already on the default
      // branch, and makes every resume retry a merge that can never succeed.
      if (!this.isMerged(repoPath, number)) throw err;
    }
    const sha = gh(
      repoPath,
      `gh pr view ${number} --json mergeCommit --jq ".mergeCommit.oid"`
    ).trim();
    if (!/^[0-9a-f]{7,40}$/.test(sha)) {
      throw new WorkflowError(
        `merged PR #${number} but could not resolve its merge commit`,
        'GH_FAILED',
        [sha.slice(0, 200)]
      );
    }
    return sha;
  }

  comment(repoPath: string, number: number, body: string): void {
    gh(repoPath, `gh pr comment ${number} --body-file -`, body);
  }

  private isMerged(repoPath: string, number: number): boolean {
    try {
      return (
        gh(
          repoPath,
          `gh pr view ${number} --json state --jq ".state"`
        ).trim() === 'MERGED'
      );
    } catch {
      return false;
    }
  }

  private isStacked(repoPath: string, number: number): boolean {
    const raw = gh(
      repoPath,
      `gh api "repos/{owner}/{repo}/pulls/${number}" --jq ".stack // empty"`
    ).trim();
    return raw.length > 0 && raw !== 'null';
  }

  /**
   * A synchronous `gh pr merge` is rejected on GitHub native stacks, so the
   * stack tip is enqueued and polled instead. Merging the tip lands every PR
   * up to it onto the stack base.
   */
  private async mergeStack(repoPath: string, number: number): Promise<void> {
    const enqueued = JSON.parse(
      gh(
        repoPath,
        `gh api --method PUT "repos/{owner}/{repo}/pulls/${number}/merge-async" -f merge_method=merge -f merge_action=direct_merge`
      )
    ) as { status?: string; details?: { uuid?: string } };

    if (enqueued.status === 'merged') return;

    const uuid = enqueued.details?.uuid;
    if (enqueued.status !== 'pending' || uuid === undefined) {
      throw new WorkflowError(
        `merge-async did not enqueue PR #${number}`,
        'GH_FAILED',
        [`status: ${enqueued.status ?? 'unknown'}`]
      );
    }

    const deadline = Date.now() + MERGE_ASYNC_TIMEOUT_MS;
    for (;;) {
      const poll = JSON.parse(
        gh(
          repoPath,
          `gh api "repos/{owner}/{repo}/pulls/${number}/merge-async/${uuid}"`
        )
      ) as { status?: string; details?: { message?: string } };

      if (poll.status === 'merged') return;
      if (poll.status === 'failed' || poll.status === 'error') {
        throw new WorkflowError(
          `merge-async failed for PR #${number}`,
          'GH_FAILED',
          [poll.details?.message ?? 'no message']
        );
      }
      if (Date.now() >= deadline) {
        throw new WorkflowError(
          `timed out waiting for merge-async on PR #${number}`,
          'GH_FAILED',
          [`uuid: ${uuid}`]
        );
      }
      await sleep(MERGE_ASYNC_POLL_MS);
    }
  }
}
