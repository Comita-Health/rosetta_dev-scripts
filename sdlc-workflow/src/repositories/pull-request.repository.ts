import { execSync } from 'child_process';
import { injectable } from 'inversify';
import { WorkflowError } from '../types';

export interface PrRef {
  url: string;
  number: number;
}

/** GitHub's PR states, as `gh pr list --json state` reports them. */
export type PrState = 'OPEN' | 'MERGED' | 'CLOSED';

export interface PrStateRef extends PrRef {
  state: PrState;
}

/**
 * GitHub pull-request operations via the operator's `gh` session (P3 T-02)
 * — the same operator-auth pattern as `ci-status`. Resource access only:
 * idempotency and title/body composition live in the PR-lifecycle service.
 */
export interface IPullRequestRepository {
  /** The open PR whose head is `branch`, or null when none exists. */
  findByBranch(repoPath: string, branch: string): PrRef | null;
  /**
   * The most recent PR for `branch` in *any* state, with that state
   * (SPEC-PRD-0023-P1 T-04).
   *
   * @remarks
   * Distinct from {@link IPullRequestRepository.findByBranch} because a merged
   * closeout PR is the success case, and an open-state-only query cannot see
   * it: the phase-complete predicate has to accept "merged" and "open awaiting
   * Approve" alike while still rejecting "closed unmerged". Queried live on
   * every call — a cached complete flag would report a phase done after
   * someone closed its closeout PR.
   */
  latestForBranch(repoPath: string, branch: string): PrStateRef | null;
  create(
    repoPath: string,
    input: { branch: string; title: string; body: string }
  ): PrRef;
  /**
   * Merge the PR (merge commit, P3 T-04) and return the merge commit SHA.
   * Only ever called by the enforcement path when every gate is green.
   */
  merge(repoPath: string, number: number): string;
  /**
   * The PR's merge commit OID when GitHub reports it merged, else null.
   * Used by enforce-merge reconciliation: a thrown `gh pr merge` (e.g.
   * `--delete-branch` failing because the run worktree still has the
   * branch checked out) must not be trusted until this is queried.
   */
  mergeCommitOid(repoPath: string, number: number): string | null;
  /** Post an issue-style comment on the PR (reviewer overview surface). */
  comment(repoPath: string, number: number, body: string): void;
  /** Replace the PR's body — used to refresh a regenerated closeout PR. */
  updateBody(repoPath: string, number: number, body: string): void;
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

  latestForBranch(repoPath: string, branch: string): PrStateRef | null {
    const raw = gh(
      repoPath,
      `gh pr list --head "${branch}" --state all --json url,number,state --limit 1`
    );
    let refs: PrStateRef[];
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
    const sha = this.mergeCommitOid(repoPath, number);
    if (sha === null) {
      throw new WorkflowError(
        `merged PR #${number} but could not resolve its merge commit`,
        'GH_FAILED',
        []
      );
    }
    return sha;
  }

  mergeCommitOid(repoPath: string, number: number): string | null {
    const sha = gh(
      repoPath,
      `gh pr view ${number} --json mergeCommit --jq ".mergeCommit.oid // empty"`
    ).trim();
    if (!/^[0-9a-f]{7,40}$/.test(sha)) {
      return null;
    }
    return sha;
  }

  comment(repoPath: string, number: number, body: string): void {
    gh(repoPath, `gh pr comment ${number} --body-file -`, body);
  }

  updateBody(repoPath: string, number: number, body: string): void {
    gh(repoPath, `gh pr edit ${number} --body-file -`, body);
  }
}
