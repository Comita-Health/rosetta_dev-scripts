import path from 'path';
import { inject, injectable } from 'inversify';
import type { IGitRepository } from '../repositories/git.repository';
import type { IPullRequestRepository } from '../repositories/pull-request.repository';
import type { IDropStateRepository } from '../repositories/drop-state.repository';
import { WORKFLOW_TOKENS } from '../tokens';
import { DropInput, DropState, DropTask, WorkflowError } from '../types';
import {
  dropBranchName,
  parseIssueRef,
  sanitizeDropId
} from '../utils/drop-id';
import { isHumanReviewRequired } from '../utils/merge-protection';

export interface IDropService {
  arm(input: DropInput): DropState;
  openPr(dropsDir: string, dropId: string, tasks?: DropTask[]): DropState;
  mergeDirect(dropsDir: string, dropId: string): DropState;
}

/**
 * PRD-0026 drop grain: one worktree and one PR per named ship.
 * Two drops from the same tip get distinct worktrees. Merge for
 * `direct` does not wait on a human Approve; protection that still
 * requires a person fails loud.
 */
@injectable()
export class DropService implements IDropService {
  constructor(
    @inject(WORKFLOW_TOKENS.GitRepository)
    private readonly _gitRepo: IGitRepository,
    @inject(WORKFLOW_TOKENS.PullRequestRepository)
    private readonly _prRepo: IPullRequestRepository,
    @inject(WORKFLOW_TOKENS.DropStateRepository)
    private readonly _dropStateRepo: IDropStateRepository
  ) {}

  arm(input: DropInput): DropState {
    const dropId = sanitizeDropId(input.dropId);
    const issues = input.issues.map(ref => parseIssueRef(ref).slug);
    if (issues.length === 0) {
      throw new WorkflowError(
        'drop requires at least one issue ref',
        'DROP_INVALID'
      );
    }

    const existing = this.tryLoad(input.dropsDir, dropId);
    if (existing !== null) {
      return existing;
    }

    const branch = dropBranchName(dropId);
    const worktreePath = path.join(input.dropsDir, dropId, 'worktree');
    const baseSha = this._gitRepo.resolveSha(input.repoPath, input.baseRef);
    this._gitRepo.addWorktree(
      input.repoPath,
      worktreePath,
      branch,
      baseSha
    );

    const state: DropState = {
      dropId,
      issues,
      repoPath: input.repoPath,
      worktreePath,
      branch,
      baseSha,
      mode: input.mode,
      requireApprove: input.requireApprove,
      tasks: [],
      ...(input.envelope !== undefined ? { envelope: input.envelope } : {}),
      updatedAt: new Date().toISOString()
    };
    this._dropStateRepo.write(input.dropsDir, state);
    return state;
  }

  openPr(
    dropsDir: string,
    dropId: string,
    tasks: DropTask[] = []
  ): DropState {
    const state = this._dropStateRepo.load(dropsDir, dropId);
    this._gitRepo.push(state.worktreePath, state.branch);

    const existing = this._prRepo.findByBranch(
      state.worktreePath,
      state.branch
    );
    if (existing !== null) {
      const reused: DropState = {
        ...state,
        tasks: tasks.length > 0 ? tasks : state.tasks,
        prUrl: existing.url,
        prNumber: existing.number,
        updatedAt: new Date().toISOString()
      };
      this._dropStateRepo.write(dropsDir, reused);
      return reused;
    }

    const created = this._prRepo.create(state.worktreePath, {
      branch: state.branch,
      title: `drop(${state.dropId}): ${state.issues.join(', ')}`,
      body: this.prBody(state, tasks.length > 0 ? tasks : state.tasks)
    });
    const next: DropState = {
      ...state,
      tasks: tasks.length > 0 ? tasks : state.tasks,
      prUrl: created.url,
      prNumber: created.number,
      updatedAt: new Date().toISOString()
    };
    this._dropStateRepo.write(dropsDir, next);
    return next;
  }

  mergeDirect(dropsDir: string, dropId: string): DropState {
    const state = this._dropStateRepo.load(dropsDir, dropId);
    if (state.requireApprove) {
      throw new WorkflowError(
        'drop --require-approve is set; not merging on machine gates',
        'DROP_INVALID',
        [state.dropId]
      );
    }
    if (state.mode !== 'direct') {
      throw new WorkflowError(
        `machine-gate merge applies to direct drops only (mode=${state.mode})`,
        'DROP_INVALID',
        [state.dropId]
      );
    }
    if (state.prNumber === undefined) {
      throw new WorkflowError(
        'drop has no PR to merge',
        'DROP_INVALID',
        [state.dropId]
      );
    }
    if (state.mergedSha !== undefined) {
      return state;
    }

    try {
      const mergedSha = this._prRepo.merge(
        state.worktreePath,
        state.prNumber
      );
      const next: DropState = {
        ...state,
        mergedSha,
        updatedAt: new Date().toISOString()
      };
      this._dropStateRepo.write(dropsDir, next);
      return next;
    } catch (err) {
      const message =
        err instanceof WorkflowError
          ? [err.message, ...err.details].join(': ')
          : String(err);
      if (isHumanReviewRequired(message)) {
        throw new WorkflowError(
          'branch protection still requires a human review',
          'BRANCH_PROTECTION_REQUIRES_HUMAN',
          [message.slice(0, 500)]
        );
      }
      throw err;
    }
  }

  private tryLoad(dropsDir: string, dropId: string): DropState | null {
    try {
      return this._dropStateRepo.load(dropsDir, dropId);
    } catch (err) {
      if (err instanceof WorkflowError && err.code === 'DROP_INVALID') {
        return null;
      }
      throw err;
    }
  }

  private prBody(state: DropState, tasks: DropTask[]): string {
    const issueLines = state.issues.map(ref => `- ${ref}`).join('\n');
    const taskLines =
      tasks.length > 0
        ? tasks
            .map(
              task =>
                `- [${task.done ? 'x' : ' '}] ${task.id}: ${task.title}`
            )
            .join('\n')
        : '- [ ] (commits on this branch are the drop tasks)';
    return [
      '## Drop',
      '',
      `Id: \`${state.dropId}\``,
      `Mode: \`${state.mode}\``,
      `Base: \`${state.baseSha}\``,
      '',
      '## Issues',
      '',
      issueLines,
      '',
      '## Tasks (commits + AC checkboxes)',
      '',
      taskLines,
      ''
    ].join('\n');
  }
}
