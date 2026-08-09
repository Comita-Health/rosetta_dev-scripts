import { inject, injectable } from 'inversify';
import type { IGitHubWatchSourceRepository } from '../repositories/github-watch-source.repository';
import { WORKFLOW_TOKENS } from '../tokens';
import type { DurableWatchRecord } from '../types';
import type {
  IWatchSourceAdapter,
  WatchSourcePollResult
} from './watch-source-adapter';

const requireIssueTarget = (
  watch: DurableWatchRecord
): { repo: string; number: number } => {
  const repo = watch.target.repo;
  const number = watch.target.number;
  if (typeof repo !== 'string' || repo.trim().length === 0) {
    throw new TypeError('issue-state adapter requires target.repo');
  }
  if (typeof number !== 'number' || Number.isSafeInteger(number) === false) {
    throw new TypeError('issue-state adapter requires target.number');
  }
  return { repo: repo.trim(), number };
};

/**
 * `issue-state` source adapter — needs-human blocker close → wake.
 *
 * Emits a single `closed` signal then terminals the watch. Delivery into the
 * wake inbox is the poll scheduler's job; this adapter never writes wakes.
 */
@injectable()
export class IssueStateWatchSourceAdapter implements IWatchSourceAdapter {
  constructor(
    @inject(WORKFLOW_TOKENS.GitHubWatchSourceRepository)
    private readonly _github: IGitHubWatchSourceRepository
  ) {}

  async poll(
    workspaceRoot: string,
    watch: DurableWatchRecord
  ): Promise<WatchSourcePollResult> {
    const { repo, number } = requireIssueTarget(watch);
    const issue = this._github.getIssue(workspaceRoot, repo, number);
    const state = issue.state.toUpperCase();
    if (state !== 'CLOSED') {
      return { signals: [] };
    }
    const observedAt =
      issue.closedAt !== null &&
      Number.isNaN(Date.parse(issue.closedAt)) === false
        ? issue.closedAt
        : new Date().toISOString();
    return {
      signals: [
        {
          id: `closed:${number}`,
          observedAt,
          prompt:
            issue.title.length > 0
              ? `Issue ${repo}#${number} closed: ${issue.title}`
              : `Issue ${repo}#${number} closed`,
          data: {
            signal: 'closed',
            repo,
            number,
            title: issue.title
          }
        }
      ],
      terminalState: 'closed'
    };
  }
}
