import path from 'path';
import { inject, injectable } from 'inversify';
import type { IGitRepository } from '../repositories/git.repository';
import type {
  IPullRequestRepository,
  PrRef
} from '../repositories/pull-request.repository';
import type { ISpecFileRepository } from '../repositories/spec-file.repository';
import { WORKFLOW_TOKENS } from '../tokens';
import { CloseoutAggregate, SpecDocument, SpecStatus } from '../types';
import {
  applyCloseout,
  closeoutBody,
  closeoutBranch,
  closeoutTitle,
  type CloseoutEdit
} from '../utils/spec-closeout';

export interface CloseoutInput {
  /** Primary checkout of the repo owning the spec. */
  repoPath: string;
  runsDir: string;
  runId: string;
  spec: SpecDocument;
  /** Repo-relative path of the spec document, e.g. `specs/PRD-0023/phase-1-spec.md`. */
  specRelPath: string;
  /** The T-01 verdict aggregation this closeout derives everything from. */
  aggregate: CloseoutAggregate;
}

export interface CloseoutOutcome {
  kind: 'created' | 'updated' | 'unchanged' | 'skipped';
  pr?: PrRef;
  /** Present only when this closeout wrote the spec status. */
  statusWritten?: SpecStatus;
  tickedCount: number;
  remainderCount: number;
  /** Why a `skipped` / `unchanged` outcome happened, for the monitor log. */
  detail?: string;
}

/**
 * SPEC-PRD-0023-P1 T-02 / T-03: generate the closeout pull request for a
 * phase whose tasks have all merged.
 *
 * The spec diff is derived, never authored: checkbox state and the `status:`
 * field come from the T-01 aggregation of recorded verdicts, and the PR body
 * cites the (task, gate, evidence) behind every tick. This is the only writer
 * permitted to touch `specs/**` — agent task diffs hard-breach the envelope
 * gate on those paths — which is why it goes through a single privileged
 * repository route rather than writing files itself.
 *
 * @remarks
 * Idempotent by branch, not by title: one closeout branch per spec, found via
 * `gh pr list --head`. Re-invoking after an interruption pushes the refreshed
 * spec to that same branch and rewrites the body of the same PR number, so a
 * killed closeout job cannot leave two open PRs against one spec. Read the
 * base spec from `origin/<default>` rather than the working tree — the local
 * checkout may sit on an unrelated branch mid-run.
 */
export interface ICloseoutService {
  generate(input: CloseoutInput): Promise<CloseoutOutcome>;
}

@injectable()
export class CloseoutService implements ICloseoutService {
  constructor(
    @inject(WORKFLOW_TOKENS.GitRepository)
    private readonly _gitRepo: IGitRepository,
    @inject(WORKFLOW_TOKENS.PullRequestRepository)
    private readonly _prRepo: IPullRequestRepository,
    @inject(WORKFLOW_TOKENS.SpecFileRepository)
    private readonly _specFileRepo: ISpecFileRepository
  ) {}

  async generate(input: CloseoutInput): Promise<CloseoutOutcome> {
    const branch = closeoutBranch(input.spec.id);
    this._gitRepo.fetch(input.repoPath);
    const defaultBranch = this._gitRepo.defaultBranch(input.repoPath);
    const baseRef = `origin/${defaultBranch}`;
    const baseSha = this._gitRepo.resolveSha(input.repoPath, baseRef);

    const base = this._gitRepo.fileAtRef(
      input.repoPath,
      baseRef,
      input.specRelPath
    );
    if (base === null) {
      return {
        kind: 'skipped',
        tickedCount: 0,
        remainderCount: input.aggregate.criteria.length,
        detail: `${input.specRelPath} is not present on ${baseRef} — nothing to close out`
      };
    }

    const edit = applyCloseout(base, input.aggregate);
    const body = closeoutBody({
      specId: input.spec.id,
      runId: input.runId,
      specRelPath: input.specRelPath,
      aggregate: input.aggregate,
      edit
    });

    if (!edit.changed) {
      // No derived diff means the spec already says what the verdicts say.
      // An existing PR (open or merged) is the closeout; without one there is
      // nothing to open, and saying so beats pushing an empty branch.
      const existing = this._prRepo.latestForBranch(input.repoPath, branch);
      return {
        kind: 'unchanged',
        ...(existing !== null
          ? { pr: { url: existing.url, number: existing.number } }
          : {}),
        tickedCount: 0,
        remainderCount: edit.remainder.length,
        detail:
          existing === null
            ? `${input.specRelPath} on ${baseRef} already matches the recorded verdicts, and no closeout PR exists for ${branch}`
            : `no new derived changes; closeout PR ${existing.url} is ${existing.state.toLowerCase()}`
      };
    }

    const worktreePath = path.join(
      input.runsDir,
      input.runId,
      'worktrees',
      '_closeout'
    );
    this._gitRepo.worktreeForBranch(
      input.repoPath,
      worktreePath,
      branch,
      baseSha
    );
    this._specFileRepo.writeCloseout(
      worktreePath,
      input.specRelPath,
      edit.markdown
    );

    // A resumed closeout whose commit already landed leaves a clean tree —
    // committing then would fail, so the push/PR steps below still run.
    if (this._gitRepo.status(worktreePath).trim().length > 0) {
      this._gitRepo.stageAll(worktreePath);
      this._gitRepo.commit(worktreePath, this.commitMessage(input, edit), {
        noVerify: true,
        signOff: true
      });
    }
    this._gitRepo.push(worktreePath, branch);

    const existing = this._prRepo.findByBranch(worktreePath, branch);
    if (existing !== null) {
      this._prRepo.updateBody(worktreePath, existing.number, body);
      return {
        kind: 'updated',
        pr: existing,
        ...(edit.statusWritten !== undefined
          ? { statusWritten: edit.statusWritten }
          : {}),
        tickedCount: edit.ticked.length,
        remainderCount: edit.remainder.length
      };
    }

    const created = this._prRepo.create(worktreePath, {
      branch,
      title: closeoutTitle(input.spec.id),
      body
    });
    return {
      kind: 'created',
      pr: created,
      ...(edit.statusWritten !== undefined
        ? { statusWritten: edit.statusWritten }
        : {}),
      tickedCount: edit.ticked.length,
      remainderCount: edit.remainder.length
    };
  }

  private commitMessage(input: CloseoutInput, edit: CloseoutEdit): string {
    const status =
      edit.statusWritten === undefined
        ? 'status unchanged'
        : `status: ${edit.statusWritten}`;
    return (
      `docs(${input.spec.id}): closeout from run ${input.runId} ` +
      `(${edit.ticked.length} criteria verified, ${status})`
    );
  }
}
