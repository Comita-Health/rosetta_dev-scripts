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
   * Merge the PR (merge commit, P3 T-04) and return the merge commit SHA.
   * Only ever called by the enforcement path when every gate is green.
   */
  merge(repoPath: string, number: number): string;
}

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

  merge(repoPath: string, number: number): string {
    gh(repoPath, `gh pr merge ${number} --merge`);
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
}
