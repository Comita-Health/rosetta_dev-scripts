import { inject, injectable } from 'inversify';
import type {
  GitHubCheckRun,
  GitHubCombinedStatus,
  IGitHubWatchSourceRepository
} from '../repositories/github-watch-source.repository';
import { WORKFLOW_TOKENS } from '../tokens';
import type { DurableWatchRecord } from '../types';
import type {
  IWatchSourceAdapter,
  WatchSourcePollResult,
  WatchSourceSignal
} from './watch-source-adapter';

/** Conclusions that do not count as a CI failure for wake purposes. */
const NON_FAILING_CONCLUSIONS = new Set(['success', 'neutral', 'skipped']);

const requirePrTarget = (
  watch: DurableWatchRecord
): { repo: string; number: number } => {
  const repo = watch.target.repo;
  const number = watch.target.number;
  if (typeof repo !== 'string' || repo.trim().length === 0) {
    throw new TypeError('pr-checks adapter requires target.repo');
  }
  if (typeof number !== 'number' || Number.isSafeInteger(number) === false) {
    throw new TypeError('pr-checks adapter requires target.number');
  }
  return { repo: repo.trim(), number };
};

const latestTimestamp = (
  checks: readonly GitHubCheckRun[],
  statuses: GitHubCombinedStatus,
  fallback: string
): string => {
  const candidates = [
    ...checks
      .map(run => run.completedAt)
      .filter((value): value is string => typeof value === 'string'),
    ...statuses.statuses.map(status => status.updatedAt)
  ].filter(value => Number.isNaN(Date.parse(value)) === false);
  if (candidates.length === 0) {
    return fallback;
  }
  return candidates.sort().at(-1) ?? fallback;
};

const failingCheckNames = (checks: readonly GitHubCheckRun[]): string[] =>
  checks
    .filter(
      run =>
        run.status === 'completed' &&
        (run.conclusion === null ||
          NON_FAILING_CONCLUSIONS.has(run.conclusion) === false)
    )
    .map(run => run.name);

/**
 * Roll the individual status contexts up, ignoring `combined.state`.
 *
 * The combined commit-status API defines the rollup `pending` as "no statuses
 * or a context is pending", so a Checks-API-only commit (every GitHub Actions
 * PR) reports `pending` forever with an empty `statuses` array. Reading the
 * rollup directly would wedge those watches, so the contexts are the authority
 * and `none` marks a commit with no legacy status contexts at all.
 */
const rollUpStatuses = (
  statuses: GitHubCombinedStatus
): { state: string; pending: boolean; failed: boolean } => {
  if (statuses.statuses.length === 0) {
    return { state: 'none', pending: false, failed: false };
  }
  return {
    state: statuses.state,
    pending: statuses.statuses.some(status => status.state === 'pending'),
    failed: statuses.statuses.some(
      status => status.state === 'failure' || status.state === 'error'
    )
  };
};

/**
 * Phase 1 `pr-checks` source adapter (SPEC-PRD-0020-P1 T-05).
 *
 * Normalizes Checks API terminal states and commit status-context terminal
 * states into one success or failure signal per head SHA. Like the sibling
 * pr-review adapter, it only emits signals — the poll scheduler commits them
 * through the shared wake-inbox writer.
 */
@injectable()
export class PrChecksWatchSourceAdapter implements IWatchSourceAdapter {
  constructor(
    @inject(WORKFLOW_TOKENS.GitHubWatchSourceRepository)
    private readonly _github: IGitHubWatchSourceRepository
  ) {}

  async poll(
    workspaceRoot: string,
    watch: DurableWatchRecord
  ): Promise<WatchSourcePollResult> {
    const { repo, number } = requirePrTarget(watch);
    const pr = this._github.getPullRequest(workspaceRoot, repo, number);
    if (pr.state === 'MERGED' || pr.state === 'CLOSED') {
      return { signals: [], terminalState: pr.state.toLowerCase() };
    }

    const checks = this._github.listCheckRuns(workspaceRoot, repo, pr.headSha);
    const combined = this._github.getCombinedStatus(
      workspaceRoot,
      repo,
      pr.headSha
    );

    const status = rollUpStatuses(combined);
    const checksPending = checks.some(run => run.status !== 'completed');
    if (checksPending || status.pending) {
      return { signals: [] };
    }

    // No CI surface yet — keep polling rather than inventing a green wake.
    if (checks.length === 0 && combined.statuses.length === 0) {
      return { signals: [] };
    }

    const failed = failingCheckNames(checks);
    const now = new Date().toISOString();
    const observedAt = latestTimestamp(checks, combined, now);

    if (failed.length > 0 || status.failed === true) {
      const signal: WatchSourceSignal = {
        id: `checks_failed:${pr.headSha}`,
        observedAt,
        prompt: `CI failed on ${repo}#${number} at ${pr.headSha.slice(0, 7)}`,
        data: {
          signal: 'checks_failed',
          repo,
          number,
          sha: pr.headSha,
          failedChecks: failed,
          statusState: status.state
        }
      };
      return { signals: [signal] };
    }

    const signal: WatchSourceSignal = {
      id: `checks_success:${pr.headSha}`,
      observedAt,
      prompt: `CI succeeded on ${repo}#${number} at ${pr.headSha.slice(0, 7)}`,
      data: {
        signal: 'checks_success',
        repo,
        number,
        sha: pr.headSha,
        statusState: status.state
      }
    };
    return { signals: [signal] };
  }
}
