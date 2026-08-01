import { execSync } from 'child_process';
import { injectable } from 'inversify';

export interface CheckRunSummary {
  total: number;
  failed: string[]; // names of failed check runs
  pending: string[]; // names of queued/in-progress check runs
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
}

const MAX_LOG_CHARS = 20_000;

@injectable()
export class CiStatusRepository implements ICiStatusRepository {
  checkRuns(repoPath: string, sha: string): CheckRunSummary | null {
    let raw: string;
    try {
      raw = execSync(
        `gh api "repos/{owner}/{repo}/commits/${sha}/check-runs" --jq "[.check_runs[] | {name, status, conclusion}]"`,
        { cwd: repoPath, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
      );
    } catch {
      return null;
    }

    let runs: Array<{
      name: string;
      status: string;
      conclusion: string | null;
    }>;
    try {
      runs = JSON.parse(raw);
    } catch {
      return null;
    }

    return {
      total: runs.length,
      failed: runs
        .filter(
          run =>
            run.status === 'completed' &&
            run.conclusion !== 'success' &&
            run.conclusion !== 'neutral' &&
            run.conclusion !== 'skipped'
        )
        .map(run => run.name),
      pending: runs
        .filter(run => run.status !== 'completed')
        .map(run => run.name)
    };
  }

  failedLogs(repoPath: string, sha: string): string {
    try {
      const raw = execSync(
        `gh run list --commit ${sha} --status failure --json databaseId --jq ".[].databaseId"`,
        { cwd: repoPath, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
      );
      const ids = raw
        .split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0);
      const logs: string[] = [];
      for (const id of ids) {
        try {
          logs.push(
            execSync(`gh run view ${id} --log-failed`, {
              cwd: repoPath,
              encoding: 'utf-8',
              stdio: ['pipe', 'pipe', 'pipe']
            })
          );
        } catch {
          // A single unreadable run does not void the rest.
        }
      }
      return logs.join('\n').slice(-MAX_LOG_CHARS);
    } catch {
      return '';
    }
  }
}
