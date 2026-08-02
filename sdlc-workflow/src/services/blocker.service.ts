import { inject, injectable } from 'inversify';
import type { IGitHubIssueRepository } from '../repositories/github-issue.repository';
import type { IRunStateRepository } from '../repositories/run-state.repository';
import { WORKFLOW_TOKENS } from '../tokens';
import { ExceptionTrigger, WorkflowError } from '../types';
import { escalationKey } from './escalation.service';

export interface BlockerStatus {
  taskId: string;
  trigger: ExceptionTrigger;
  key: string;
  /** `cleared` once the matching needs-human issue is closed. */
  state: 'open' | 'cleared';
}

export interface BlockerReport {
  runId: string;
  blockers: BlockerStatus[];
  /**
   * True when the run has recorded exceptions and every one has been
   * cleared. False when nothing is blocking (nothing to resume) or when at
   * least one blocker is still open.
   */
  resumable: boolean;
}

export interface BlockerQueryInput {
  runsDir: string;
  runId: string;
  repoPath: string;
}

/**
 * Reads the human side of the loop back off GitHub: closing a `needs-human`
 * issue is the resume signal, so this reports which of a run's recorded
 * exceptions the human has cleared. The continuity daemon polls it to decide
 * whether relaunching the supervisor would accomplish anything.
 */
export interface IBlockerService {
  query(input: BlockerQueryInput): BlockerReport;
}

@injectable()
export class BlockerService implements IBlockerService {
  constructor(
    @inject(WORKFLOW_TOKENS.RunStateRepository)
    private readonly _runStateRepo: IRunStateRepository,
    @inject(WORKFLOW_TOKENS.GitHubIssueRepository)
    private readonly _issueRepo: IGitHubIssueRepository
  ) {}

  query(input: BlockerQueryInput): BlockerReport {
    const state = this._runStateRepo.load(input.runsDir, input.runId);
    if (state === null) {
      throw new WorkflowError(
        `no run state for ${input.runId}`,
        'RUN_NOT_FOUND',
        [input.runsDir]
      );
    }

    // Deduplicate by key: a resumed run re-records the same trigger, and one
    // GitHub issue backs all of those repeats.
    const seen = new Set<string>();
    const blockers: BlockerStatus[] = [];
    for (const entry of state.exceptions) {
      const key = escalationKey(input.runId, entry);
      if (seen.has(key)) continue;
      seen.add(key);
      blockers.push({
        taskId: entry.taskId ?? 'run',
        trigger: entry.trigger,
        key,
        state: this._issueRepo.isResolved(input.repoPath, key)
          ? 'cleared'
          : 'open'
      });
    }

    return {
      runId: input.runId,
      blockers,
      resumable:
        blockers.length > 0 &&
        blockers.every(blocker => blocker.state === 'cleared')
    };
  }
}
