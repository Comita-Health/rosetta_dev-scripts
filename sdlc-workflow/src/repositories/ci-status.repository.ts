import { injectable } from 'inversify';
import { WorkflowError } from '../types';
import { runGh } from '../utils/gh-cli';
import { originSlug } from '../utils/gh-repo';

export interface CheckRunFailedLink {
  name: string;
  /** Prefer Actions `html_url`; fall back to integrator `details_url`. */
  url: string;
}

export interface CheckRunSummary {
  total: number;
  failed: string[]; // names of failed check runs
  pending: string[]; // names of queued/in-progress check runs
  /** Deep links for failed checks when GitHub returned a URL. */
  failedLinks: CheckRunFailedLink[];
}

export type CommitStatusState = 'error' | 'failure' | 'pending' | 'success';

export interface CommitStatusInput {
  state: CommitStatusState;
  context: string;
  description?: string;
  targetUrl?: string;
}

/**
 * Queries GitHub check runs for a commit SHA via the operator's `gh`
 * session (same operator-auth pattern as cloning). Returns null when the
 * commit is unknown to the remote (task branches are not pushed in shadow
 * mode) or `gh` cannot answer — the CI gate reports that state honestly.
 */
export interface ICiStatusRepository {
  checkRuns(repoPath: string, sha: string): CheckRunSummary | null;
  /**
   * Failed-step logs for the workflow runs at `sha` (P3 T-03) — the fix
   * agent's context. Best effort: returns '' when logs cannot be fetched.
   */
  failedLogs(repoPath: string, sha: string): string;
  /**
   * Create a commit status (Statuses API — works with `gh` user auth; Check
   * Runs require a GitHub App). Used to surface the reviewer gate on the PR.
   */
  createStatus(repoPath: string, sha: string, input: CommitStatusInput): void;
}

const MAX_LOG_CHARS = 20_000;

@injectable()
export class CiStatusRepository implements ICiStatusRepository {
  checkRuns(repoPath: string, sha: string): CheckRunSummary | null {
    let raw: string;
    try {
      raw = runGh(
        repoPath,
        `gh api "repos/${originSlug(repoPath)}/commits/${sha}/check-runs" --jq "[.check_runs[] | {name, status, conclusion, html_url, details_url}]"`
      );
    } catch {
      return null;
    }

    let runs: Array<{
      name: string;
      status: string;
      conclusion: string | null;
      html_url?: string | null;
      details_url?: string | null;
    }>;
    try {
      runs = JSON.parse(raw);
    } catch {
      return null;
    }

    const failedRuns = runs.filter(
      run =>
        run.status === 'completed' &&
        run.conclusion !== 'success' &&
        run.conclusion !== 'neutral' &&
        run.conclusion !== 'skipped'
    );

    const failedLinks: CheckRunFailedLink[] = [];
    for (const run of failedRuns) {
      const url =
        typeof run.html_url === 'string' && run.html_url.length > 0
          ? run.html_url
          : typeof run.details_url === 'string' && run.details_url.length > 0
            ? run.details_url
            : undefined;
      if (url !== undefined) {
        failedLinks.push({ name: run.name, url });
      }
    }

    return {
      total: runs.length,
      failed: failedRuns.map(run => run.name),
      pending: runs
        .filter(run => run.status !== 'completed')
        .map(run => run.name),
      failedLinks
    };
  }

  failedLogs(repoPath: string, sha: string): string {
    try {
      const raw = runGh(
        repoPath,
        `gh run list --commit ${sha} --status failure --json databaseId --jq ".[].databaseId"`
      );
      const ids = raw
        .split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0);
      const logs: string[] = [];
      for (const id of ids) {
        try {
          logs.push(runGh(repoPath, `gh run view ${id} --log-failed`));
        } catch {
          // A single unreadable run does not void the rest.
        }
      }
      return logs.join('\n').slice(-MAX_LOG_CHARS);
    } catch {
      return '';
    }
  }

  createStatus(repoPath: string, sha: string, input: CommitStatusInput): void {
    const payload: Record<string, string> = {
      state: input.state,
      context: input.context
    };
    if (input.description !== undefined && input.description.length > 0) {
      payload.description = input.description;
    }
    if (input.targetUrl !== undefined && input.targetUrl.length > 0) {
      payload.target_url = input.targetUrl;
    }
    try {
      runGh(
        repoPath,
        `gh api --method POST "repos/${originSlug(repoPath)}/statuses/${sha}" --input -`,
        { stdin: JSON.stringify(payload), requireAddi: true }
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new WorkflowError(`gh api statuses/${sha} failed`, 'GH_FAILED', [
        message.slice(0, 1000)
      ]);
    }
  }
}
