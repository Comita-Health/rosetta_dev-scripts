import { existsSync } from 'fs';
import { inject, injectable } from 'inversify';
import type { IIssueRepository } from '../repositories/issue.repository';
import type { IRunStateRepository } from '../repositories/run-state.repository';
import { WORKFLOW_TOKENS } from '../tokens';
import type { ExceptionTrigger } from '../types';
import { WorkflowError } from '../types';
import { escalationTitle } from './escalation.service';

export interface BlockerStatus {
  taskId: string;
  trigger: ExceptionTrigger;
  title: string;
  /** `cleared` once the matching needs-human issue is no longer open. */
  state: 'open' | 'cleared';
}

export interface BlockerReport {
  runId: string;
  blockers: BlockerStatus[];
  /**
   * True when the run has recorded exceptions and every matching needs-human
   * issue is closed (or absent). False when nothing is blocking, or when at
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
 * Engine blockers/resumable reporting (SPEC-PRD-0020-P2 T-03).
 *
 * Reads recorded exceptions from {@link IRunStateRepository} and open
 * needs-human issues via {@link IIssueRepository} — the TypeScript reader the
 * bash continuity daemon used to scrape through `blockers --json` + gh/python.
 */
export interface IBlockerService {
  /**
   * Report recorded exceptions vs open needs-human issues for one run.
   *
   * @throws {WorkflowError} `RUN_NOT_FOUND` when `state.json` is missing —
   * callers that already loaded run state (e.g. ContinuityService) should not
   * hit this; probe-style callers must catch.
   */
  query(input: BlockerQueryInput): BlockerReport;
}

@injectable()
export class BlockerService implements IBlockerService {
  constructor(
    @inject(WORKFLOW_TOKENS.RunStateRepository)
    private readonly _runStateRepo: IRunStateRepository,
    @inject(WORKFLOW_TOKENS.IssueRepository)
    private readonly _issueRepo: IIssueRepository
  ) {}

  /**
   * Report recorded exceptions vs open needs-human issues for one run.
   *
   * Invariants:
   * - Missing run state throws {@link WorkflowError} with code `RUN_NOT_FOUND`
   *   (not a soft empty report). Continuity catches and treats that as "no
   *   blocker probe" so a missing-state race does not strand relaunch.
   * - Empty / non-existent `repoPath` returns `{ blockers: [], resumable: false }`
   *   without probing issues — same shape as "nothing blocking".
   * - Transient {@link IIssueRepository.findByTitle} failures fail open to
   *   `{ blockers: [], resumable: false }` so continuity may still relaunch
   *   rather than strand the run on a flaky gh probe.
   * - `resumable` is true only when there is at least one recorded exception
   *   and every matching needs-human issue is closed (or absent). Historical
   *   cleared exceptions keep `resumable` true; callers must not treat that
   *   flag as a permanent skip of dead-supervisor relaunch / abandon.
   */
  query(input: BlockerQueryInput): BlockerReport {
    const state = this._runStateRepo.load(input.runsDir, input.runId);
    if (state === null) {
      throw new WorkflowError(
        `no run state for ${input.runId}`,
        'RUN_NOT_FOUND',
        [input.runsDir]
      );
    }

    const repoPath = input.repoPath.trim();
    if (repoPath.length === 0 || existsSync(repoPath) === false) {
      return { runId: input.runId, blockers: [], resumable: false };
    }

    const seen = new Set<string>();
    const blockers: BlockerStatus[] = [];
    try {
      for (const entry of state.exceptions) {
        const title = escalationTitle(input.runId, entry);
        if (seen.has(title) === true) {
          continue;
        }
        seen.add(title);
        const open = this._issueRepo.findByTitle(repoPath, title);
        blockers.push({
          taskId: entry.taskId ?? 'run',
          trigger: entry.trigger,
          title,
          state: open !== null ? 'open' : 'cleared'
        });
      }
    } catch {
      // Transient gh failures fail open: report no blockers so continuity
      // does not strand relaunches — matching ContinuityService T-01.
      return { runId: input.runId, blockers: [], resumable: false };
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
