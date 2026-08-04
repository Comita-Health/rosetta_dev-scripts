import { existsSync, readFileSync } from 'fs';
import { inject, injectable } from 'inversify';
import path from 'path';
import type { IGitRepository } from './git.repository';
import { WORKFLOW_TOKENS } from '../tokens';

/** Repo-relative location of the protected-surface map. */
export const SURFACES_CONTRACT_PATH = '.sdlc/surfaces.json';

/**
 * Loads the repo-level protected-surface map: label → path globs, from
 * `<repo>/.sdlc/surfaces.json`. Data-driven so envelope labels like
 * `migrations` or `auth` are never hardcoded in gate logic
 * (SPEC-PRD-0011-P2 T-02).
 *
 * Two read paths with different trust models
 * (SPEC-BUG-envelope-spec-integrity-P1 T-03):
 *
 * - {@link load} reads the operator's working tree. Synthesis-time only —
 *   gates must never call it, because a locally edited (uncommitted)
 *   contract would then influence a verdict.
 * - {@link loadAtRef} reads the blob committed at a git ref — the tree
 *   under judgment. Evaluation-time readers use this; `null` means the
 *   contract does not exist at that ref, which the gate reports as a
 *   named error rather than falling back to local disk.
 */
export interface ISurfaceMapRepository {
  load(repoPath: string): Record<string, string[]>;
  loadAtRef(repoPath: string, ref: string): Record<string, string[]> | null;
}

@injectable()
export class SurfaceMapRepository implements ISurfaceMapRepository {
  constructor(
    @inject(WORKFLOW_TOKENS.GitRepository)
    private readonly _gitRepo: IGitRepository
  ) {}

  load(repoPath: string): Record<string, string[]> {
    const file = path.join(repoPath, SURFACES_CONTRACT_PATH);
    if (!existsSync(file)) return {};
    return JSON.parse(readFileSync(file, 'utf-8')) as Record<string, string[]>;
  }

  loadAtRef(repoPath: string, ref: string): Record<string, string[]> | null {
    const blob = this._gitRepo.fileAtRef(repoPath, ref, SURFACES_CONTRACT_PATH);
    if (blob === null) return null;
    return JSON.parse(blob) as Record<string, string[]>;
  }
}
