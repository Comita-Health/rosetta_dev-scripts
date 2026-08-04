import { inject, injectable } from 'inversify';
import type { IGitRepository } from './git.repository';
import { WORKFLOW_TOKENS } from '../tokens';
import { ReviewChecklist } from '../types';
import { parseReviewChecklist } from '../utils/review-checklist';

/** Repo-relative location of the optional review-checklist contract. */
export const REVIEW_CHECKLIST_CONTRACT_PATH = '.sdlc/review-checklist.md';

/**
 * Loads the repo-owned review checklist (T-01): items the reviewer agent
 * must evaluate the diff against. The engine ships no content — consumers
 * declare their own; a repo without the file keeps the pre-checklist
 * reviewer prompt/verdict shape.
 *
 * Resolved from the git tree under judgment (`ref` — the task's PR tip),
 * never the local checkout, matching the T-03 tree-resolution rule
 * (`SurfaceMapRepository`): an uncommitted checklist edit cannot sway a
 * verdict.
 */
export interface IReviewChecklistRepository {
  /** `null` when the ref carries no `.sdlc/review-checklist.md`. */
  loadAtRef(repoPath: string, ref: string): ReviewChecklist | null;
}

@injectable()
export class ReviewChecklistRepository implements IReviewChecklistRepository {
  constructor(
    @inject(WORKFLOW_TOKENS.GitRepository)
    private readonly _gitRepo: IGitRepository
  ) {}

  loadAtRef(repoPath: string, ref: string): ReviewChecklist | null {
    const blob = this._gitRepo.fileAtRef(
      repoPath,
      ref,
      REVIEW_CHECKLIST_CONTRACT_PATH
    );
    if (blob === null) return null;
    return parseReviewChecklist(blob);
  }
}
