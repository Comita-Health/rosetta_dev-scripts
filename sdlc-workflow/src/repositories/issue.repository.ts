import { execSync } from 'child_process';
import { injectable } from 'inversify';
import { WorkflowError } from '../types';

export interface IssueRef {
  url: string;
  number: number;
}

export interface CreateIssueInput {
  title: string;
  body: string;
  /** GitHub login; omit to post unassigned. */
  assignee?: string;
}

/**
 * GitHub issue operations via the operator's `gh` session — same pattern as
 * `PullRequestRepository`. Resource access only: escalation idempotence and
 * monitor-log warnings live in EscalationService.
 */
export interface IIssueRepository {
  /** Open issue whose title exactly matches, or null. */
  findByTitle(repoPath: string, title: string): IssueRef | null;
  create(repoPath: string, input: CreateIssueInput): IssueRef;
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
export class IssueRepository implements IIssueRepository {
  findByTitle(repoPath: string, title: string): IssueRef | null {
    // Quote for shell; exact title match is applied after JSON parse.
    const escaped = title.replace(/"/g, '\\"');
    const raw = gh(
      repoPath,
      `gh issue list --state open --search "in:title \\"${escaped}\\"" --json url,number,title --limit 20`
    );
    let issues: Array<IssueRef & { title: string }>;
    try {
      issues = JSON.parse(raw);
    } catch {
      throw new WorkflowError(
        'gh issue list returned unparseable JSON',
        'GH_FAILED',
        [raw.slice(0, 500)]
      );
    }
    const match = issues.find(issue => issue.title === title);
    if (match === undefined) {
      return null;
    }
    return { url: match.url, number: match.number };
  }

  create(repoPath: string, input: CreateIssueInput): IssueRef {
    const assigneeFlag =
      input.assignee !== undefined && input.assignee.length > 0
        ? ` --assignee "${input.assignee.replace(/"/g, '\\"')}"`
        : '';
    const url = gh(
      repoPath,
      `gh issue create --title "${input.title.replace(/"/g, '\\"')}"${assigneeFlag} --body-file -`,
      input.body
    ).trim();
    const match = url.match(/\/issues\/(\d+)\s*$/);
    if (match === null) {
      throw new WorkflowError(
        'gh issue create did not return an issue URL',
        'GH_FAILED',
        [url.slice(0, 500)]
      );
    }
    return { url, number: Number(match[1]) };
  }
}
