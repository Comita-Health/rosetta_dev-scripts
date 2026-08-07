import { injectable } from 'inversify';
import { WorkflowError } from '../types';
import { runGh } from '../utils/gh-cli';

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
 * GitHub issue operations via `gh` — same pattern as `PullRequestRepository`.
 * Resource access only: escalation idempotence and monitor-log warnings live
 * in EscalationService.
 *
 * @remarks
 * Creates always run as the workspace GitHub App (Addi). Ambient human auth
 * is refused with `GH_NOT_ADDI` rather than filing needs-human issues under
 * the operator's login (see {@link runGh} / `envForAddiWrite`).
 */
export interface IIssueRepository {
  /** Open issue whose title exactly matches, or null. */
  findByTitle(repoPath: string, title: string): IssueRef | null;
  create(repoPath: string, input: CreateIssueInput): IssueRef;
}

@injectable()
export class IssueRepository implements IIssueRepository {
  findByTitle(repoPath: string, title: string): IssueRef | null {
    // Quote for shell; exact title match is applied after JSON parse.
    const escaped = title.replace(/"/g, '\\"');
    const raw = runGh(
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
    const url = runGh(
      repoPath,
      `gh issue create --title "${input.title.replace(/"/g, '\\"')}"${assigneeFlag} --body-file -`,
      { stdin: input.body, requireAddi: true }
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
