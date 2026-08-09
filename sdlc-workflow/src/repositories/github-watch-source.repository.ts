import { inject, injectable } from 'inversify';
import { WORKFLOW_TOKENS } from '../tokens';
import { WorkflowError } from '../types';
import { runGh } from '../utils/gh-cli';
import type { IDaemonConfigRepository } from './daemon-config.repository';

/** One pull-request review row from the GitHub REST reviews list. */
export interface GitHubPrReview {
  id: number;
  state: string;
  userLogin: string;
  userType: string;
  submittedAt: string | null;
  body: string;
}

/** One inline pull-request review comment. */
export interface GitHubPrReviewComment {
  id: number;
  userLogin: string;
  userType: string;
  createdAt: string;
  body: string;
  path: string;
}

/** Minimal PR snapshot needed by watch adapters. */
export interface GitHubPrSnapshot {
  state: string;
  headSha: string;
  /** Present when the PR is merged; otherwise null. */
  mergeCommitOid: string | null;
}

/** Minimal issue snapshot for `issue-state` watches. */
export interface GitHubIssueSnapshot {
  state: string;
  title: string;
  closedAt: string | null;
}

/** One Checks API run for a commit. */
export interface GitHubCheckRun {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  completedAt: string | null;
}

/** One commit status-context row. */
export interface GitHubStatusContext {
  context: string;
  state: string;
  updatedAt: string;
}

/** Combined commit status plus the individual contexts. */
export interface GitHubCombinedStatus {
  state: string;
  statuses: GitHubStatusContext[];
}

/**
 * GitHub reads for daemon watch adapters (SPEC-PRD-0020-P1 T-05).
 *
 * Every call runs under the workspace daemon contract's Addi activate script
 * (with the existing token-refresh retry in {@link runGh}), keyed by the
 * watched target's owner rather than the checkout origin.
 */
export interface IGitHubWatchSourceRepository {
  getPullRequest(
    workspaceRoot: string,
    repo: string,
    number: number
  ): GitHubPrSnapshot;
  getIssue(
    workspaceRoot: string,
    repo: string,
    number: number
  ): GitHubIssueSnapshot;
  listReviews(
    workspaceRoot: string,
    repo: string,
    number: number
  ): GitHubPrReview[];
  listReviewComments(
    workspaceRoot: string,
    repo: string,
    number: number
  ): GitHubPrReviewComment[];
  listCheckRuns(
    workspaceRoot: string,
    repo: string,
    sha: string
  ): GitHubCheckRun[];
  getCombinedStatus(
    workspaceRoot: string,
    repo: string,
    sha: string
  ): GitHubCombinedStatus;
}

const requireRepo = (repo: string): { slug: string; owner: string } => {
  const slug = repo.trim();
  const owner = slug.split('/')[0] ?? '';
  if (slug.includes('/') === false || owner.length === 0) {
    throw new TypeError(
      'GitHub watch source requires target.repo as owner/name'
    );
  }
  return { slug, owner };
};

const parseJson = <T>(raw: string, label: string): T => {
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new WorkflowError(
      `gh ${label} returned unparseable JSON`,
      'GH_FAILED',
      [raw.slice(0, 500)]
    );
  }
};

type GhUser = { login?: string; type?: string } | null;

@injectable()
export class GitHubWatchSourceRepository implements IGitHubWatchSourceRepository {
  constructor(
    @inject(WORKFLOW_TOKENS.DaemonConfigRepository)
    private readonly _configRepo: IDaemonConfigRepository
  ) {}

  getPullRequest(
    workspaceRoot: string,
    repo: string,
    number: number
  ): GitHubPrSnapshot {
    const { slug } = requireRepo(repo);
    const raw = this.gh(
      workspaceRoot,
      repo,
      `gh pr view ${number} -R "${slug}" --json state,headRefOid,mergeCommit`
    );
    const parsed = parseJson<{
      state?: string;
      headRefOid?: string;
      mergeCommit?: { oid?: string } | null;
    }>(raw, 'pr view');
    const state =
      typeof parsed.state === 'string' && parsed.state.length > 0
        ? parsed.state
        : 'OPEN';
    const headSha =
      typeof parsed.headRefOid === 'string' ? parsed.headRefOid.trim() : '';
    if (headSha.length === 0) {
      throw new WorkflowError(
        `PR ${slug}#${number} has no head SHA`,
        'GH_FAILED',
        []
      );
    }
    const mergeOid =
      parsed.mergeCommit !== null &&
      parsed.mergeCommit !== undefined &&
      typeof parsed.mergeCommit.oid === 'string'
        ? parsed.mergeCommit.oid.trim()
        : '';
    return {
      state,
      headSha,
      mergeCommitOid: mergeOid.length > 0 ? mergeOid : null
    };
  }

  getIssue(
    workspaceRoot: string,
    repo: string,
    number: number
  ): GitHubIssueSnapshot {
    const { slug } = requireRepo(repo);
    const raw = this.gh(
      workspaceRoot,
      repo,
      `gh issue view ${number} -R "${slug}" --json state,title,closedAt`
    );
    const parsed = parseJson<{
      state?: string;
      title?: string;
      closedAt?: string | null;
    }>(raw, 'issue view');
    const state =
      typeof parsed.state === 'string' && parsed.state.length > 0
        ? parsed.state
        : 'OPEN';
    return {
      state,
      title: typeof parsed.title === 'string' ? parsed.title : '',
      closedAt:
        typeof parsed.closedAt === 'string' && parsed.closedAt.length > 0
          ? parsed.closedAt
          : null
    };
  }

  listReviews(
    workspaceRoot: string,
    repo: string,
    number: number
  ): GitHubPrReview[] {
    const { slug } = requireRepo(repo);
    // --paginate merges list pages into one JSON array for REST collection
    // endpoints, so the adapter can treat the body as a single array.
    const raw = this.gh(
      workspaceRoot,
      repo,
      `gh api --paginate "repos/${slug}/pulls/${number}/reviews"`
    );
    const rows = parseJson<
      Array<{
        id: number;
        state: string;
        body?: string | null;
        submitted_at?: string | null;
        user?: GhUser;
      }>
    >(raw, 'list reviews');
    return rows.map(row => ({
      id: row.id,
      state: row.state,
      body: typeof row.body === 'string' ? row.body : '',
      submittedAt:
        typeof row.submitted_at === 'string' && row.submitted_at.length > 0
          ? row.submitted_at
          : null,
      userLogin:
        row.user !== null &&
        row.user !== undefined &&
        typeof row.user.login === 'string'
          ? row.user.login
          : '',
      userType:
        row.user !== null &&
        row.user !== undefined &&
        typeof row.user.type === 'string'
          ? row.user.type
          : 'User'
    }));
  }

  listReviewComments(
    workspaceRoot: string,
    repo: string,
    number: number
  ): GitHubPrReviewComment[] {
    const { slug } = requireRepo(repo);
    const raw = this.gh(
      workspaceRoot,
      repo,
      `gh api --paginate "repos/${slug}/pulls/${number}/comments"`
    );
    const rows = parseJson<
      Array<{
        id: number;
        body?: string | null;
        path?: string | null;
        created_at: string;
        user?: GhUser;
      }>
    >(raw, 'list review comments');
    return rows.map(row => ({
      id: row.id,
      body: typeof row.body === 'string' ? row.body : '',
      path: typeof row.path === 'string' ? row.path : '',
      createdAt: row.created_at,
      userLogin:
        row.user !== null &&
        row.user !== undefined &&
        typeof row.user.login === 'string'
          ? row.user.login
          : '',
      userType:
        row.user !== null &&
        row.user !== undefined &&
        typeof row.user.type === 'string'
          ? row.user.type
          : 'User'
    }));
  }

  listCheckRuns(
    workspaceRoot: string,
    repo: string,
    sha: string
  ): GitHubCheckRun[] {
    const { slug } = requireRepo(repo);
    // check-runs answers with an object, not an array, so --paginate alone
    // would emit one JSON object per page. --slurp wraps the pages in an outer
    // array; it cannot be combined with --jq, so the pages are merged here.
    // Without this a busy commit's later pages are invisible and a terminal
    // verdict can be read off an incomplete first page.
    const raw = this.gh(
      workspaceRoot,
      repo,
      `gh api --paginate --slurp "repos/${slug}/commits/${sha}/check-runs?per_page=100"`
    );
    const pages = parseJson<
      Array<{
        check_runs?: Array<{
          id: number;
          name: string;
          status: string;
          conclusion: string | null;
          completed_at: string | null;
        }> | null;
      }>
    >(raw, 'list check-runs');
    return pages.flatMap(page =>
      (page.check_runs ?? []).map(row => ({
        id: row.id,
        name: row.name,
        status: row.status,
        conclusion: row.conclusion,
        completedAt: row.completed_at
      }))
    );
  }

  getCombinedStatus(
    workspaceRoot: string,
    repo: string,
    sha: string
  ): GitHubCombinedStatus {
    const { slug } = requireRepo(repo);
    const raw = this.gh(
      workspaceRoot,
      repo,
      `gh api "repos/${slug}/commits/${sha}/status"`
    );
    const parsed = parseJson<{
      state?: string;
      statuses?: Array<{
        context: string;
        state: string;
        updated_at: string;
      }>;
    }>(raw, 'combined status');
    return {
      state:
        typeof parsed.state === 'string' && parsed.state.length > 0
          ? parsed.state
          : 'pending',
      statuses: (parsed.statuses ?? []).map(row => ({
        context: row.context,
        state: row.state,
        updatedAt: row.updated_at
      }))
    };
  }

  /**
   * `gh` under the workspace Addi activate script for the watched owner's App.
   *
   * `requireAddi: true` so ambient human tokens never poll daemon watches —
   * the PRD identity constraint is absolute for this path.
   */
  private gh(workspaceRoot: string, repo: string, command: string): string {
    const { owner } = requireRepo(repo);
    const { config } = this._configRepo.load(workspaceRoot);
    return runGh(workspaceRoot, command, {
      requireAddi: true,
      owner,
      env: { SDLC_GH_ACTIVATE: config.activateScript }
    });
  }
}
