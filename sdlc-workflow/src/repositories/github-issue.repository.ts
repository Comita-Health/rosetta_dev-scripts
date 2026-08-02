import { execSync } from 'child_process';
import { injectable } from 'inversify';
import { WorkflowError } from '../types';

export interface IssueRef {
  number: number;
  url: string;
  state: 'OPEN' | 'CLOSED';
}

export interface UpsertIssueInput {
  repoPath: string;
  /** Stable key written into the body as an HTML comment marker. */
  key: string;
  title: string;
  body: string;
  labels: string[];
}

/**
 * The `needs-human` issue surface: every escalation becomes one GitHub issue
 * a human can clear from the browser or the CLI, and closing it is the resume
 * signal the continuity daemon watches for.
 *
 * Idempotency is by an invisible marker in the body rather than by title, so
 * a re-run updates the existing issue (fresh reasons, fresh evidence) instead
 * of opening a duplicate — and a reworded title cannot orphan the original.
 */
export interface IGitHubIssueRepository {
  /** Create the issue, or refresh the open one carrying the same key. */
  upsert(input: UpsertIssueInput): IssueRef;
  /** Open issues carrying the given label, newest first. */
  findOpenByLabel(repoPath: string, label: string): IssueRef[];
  /** True when an issue with this key exists and is closed. */
  isResolved(repoPath: string, key: string): boolean;
  /** Ensure a label exists so `gh issue create --label` cannot fail. */
  ensureLabel(repoPath: string, label: string, color: string): void;
}

export const issueMarker = (key: string): string =>
  `<!-- sdlc-needs-human:${key} -->`;

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
    throw new WorkflowError(
      `gh ${command.split(' ')[1] ?? ''} failed`,
      'GH_FAILED',
      [message.slice(0, 1000)]
    );
  }
};

interface RawIssue {
  number: number;
  url: string;
  state: string;
  body?: string;
}

const toRef = (raw: RawIssue): IssueRef => ({
  number: raw.number,
  url: raw.url,
  state: raw.state.toUpperCase() === 'CLOSED' ? 'CLOSED' : 'OPEN'
});

@injectable()
export class GitHubIssueRepository implements IGitHubIssueRepository {
  upsert(input: UpsertIssueInput): IssueRef {
    const marker = issueMarker(input.key);
    const body = `${input.body}\n\n${marker}\n`;

    const existing = this.findByMarker(input.repoPath, marker, 'open');
    if (existing !== null) {
      gh(
        input.repoPath,
        `gh issue edit ${existing.number} --body-file -`,
        body
      );
      return existing;
    }

    for (const label of input.labels) {
      this.ensureLabel(input.repoPath, label, 'B60205');
    }

    const labelArgs = input.labels
      .map(label => `--label "${label.replace(/"/g, '\\"')}"`)
      .join(' ');
    const url = gh(
      input.repoPath,
      `gh issue create --title "${input.title.replace(/"/g, '\\"')}" ${labelArgs} --body-file -`,
      body
    ).trim();

    const match = url.match(/\/issues\/(\d+)\s*$/);
    if (match === null) {
      throw new WorkflowError(
        'gh issue create did not return an issue URL',
        'GH_FAILED',
        [url.slice(0, 500)]
      );
    }
    return { number: Number(match[1]), url, state: 'OPEN' };
  }

  findOpenByLabel(repoPath: string, label: string): IssueRef[] {
    const raw = gh(
      repoPath,
      `gh issue list --label "${label.replace(/"/g, '\\"')}" --state open --json number,url,state --limit 100`
    );
    return this.parseList(raw).map(toRef);
  }

  isResolved(repoPath: string, key: string): boolean {
    const marker = issueMarker(key);
    // Only a closed match counts as resolved; a missing issue means the
    // escalation was never filed, which is not the same as cleared.
    if (this.findByMarker(repoPath, marker, 'open') !== null) return false;
    return this.findByMarker(repoPath, marker, 'closed') !== null;
  }

  ensureLabel(repoPath: string, label: string, color: string): void {
    try {
      gh(
        repoPath,
        `gh label create "${label.replace(/"/g, '\\"')}" --color "${color}" --force`
      );
    } catch {
      // Label creation is best-effort: an existing label, or a token without
      // label scope, must not stop the escalation from being filed.
    }
  }

  private findByMarker(
    repoPath: string,
    marker: string,
    state: 'open' | 'closed'
  ): IssueRef | null {
    const raw = gh(
      repoPath,
      `gh issue list --state ${state} --json number,url,state,body --limit 100`
    );
    const found = this.parseList(raw).find(
      issue => issue.body !== undefined && issue.body.includes(marker)
    );
    return found === undefined ? null : toRef(found);
  }

  private parseList(raw: string): RawIssue[] {
    try {
      return JSON.parse(raw) as RawIssue[];
    } catch {
      throw new WorkflowError(
        'gh issue list returned unparseable JSON',
        'GH_FAILED',
        [raw.slice(0, 500)]
      );
    }
  }
}
