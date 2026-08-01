import { inject, injectable } from 'inversify';
import type { IGitRepository } from '../repositories/git.repository';
import type {
  IPullRequestRepository,
  PrRef
} from '../repositories/pull-request.repository';
import { WORKFLOW_TOKENS } from '../tokens';
import { GateVerdict, SpecDocument, SpecTask } from '../types';
import { prBody, prTitle } from '../utils/pr-content';

export interface OpenTaskPrInput {
  /** Worktree checkout the task branch lives in (push runs here). */
  worktreePath: string;
  branch: string;
  runId: string;
  spec: SpecDocument;
  task: SpecTask;
  /** Verdicts recorded for this task so far (empty on first pass). */
  verdicts: GateVerdict[];
}

export interface OpenTaskPrOutcome extends PrRef {
  /** False when an existing open PR for the branch was reused. */
  created: boolean;
}

/**
 * P3 T-02: push the task branch and open its PR — the subject of the
 * reviewer and CI gates. Idempotent per branch: an existing open PR is
 * reused, never duplicated, so kill-resume finds the same PR. Failures
 * throw typed errors; the caller records them without corrupting state.
 */
export interface IPrLifecycleService {
  openTaskPr(input: OpenTaskPrInput): OpenTaskPrOutcome;
}

@injectable()
export class PrLifecycleService implements IPrLifecycleService {
  constructor(
    @inject(WORKFLOW_TOKENS.GitRepository)
    private readonly _gitRepo: IGitRepository,
    @inject(WORKFLOW_TOKENS.PullRequestRepository)
    private readonly _prRepo: IPullRequestRepository
  ) {}

  openTaskPr(input: OpenTaskPrInput): OpenTaskPrOutcome {
    // Push first: reuse still needs the latest head on the remote.
    this._gitRepo.push(input.worktreePath, input.branch);

    const existing = this._prRepo.findByBranch(
      input.worktreePath,
      input.branch
    );
    if (existing !== null) {
      return { ...existing, created: false };
    }

    const created = this._prRepo.create(input.worktreePath, {
      branch: input.branch,
      title: prTitle(input.runId, input.task),
      body: prBody(
        input.spec,
        input.task,
        input.runId,
        input.branch,
        input.verdicts
      )
    });
    return { ...created, created: true };
  }
}
