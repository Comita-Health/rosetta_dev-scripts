import { existsSync, readFileSync } from 'fs';
import { inject, injectable } from 'inversify';
import type { IGitRepository } from './git.repository';
import { WORKFLOW_TOKENS } from '../tokens';
import { SpecDocument, WorkflowError } from '../types';
import { parseSpec } from '../utils/spec-parser';

/**
 * Reads an ADR-0008 implementation spec into a typed document.
 * Enforce runs load the default-branch blob via {@link readAtRef} so a stale
 * operator working tree cannot block the next supervise wave.
 */
export interface ISpecDocRepository {
  /** Parse a working-tree file (shadow / tooling). */
  read(specPath: string): SpecDocument;
  /**
   * Parse the file at `ref:relPath` in `repoPath`.
   * Returns null when the path is absent on that ref (not yet merged).
   */
  readAtRef(
    repoPath: string,
    ref: string,
    relPath: string
  ): SpecDocument | null;
}

@injectable()
export class SpecDocRepository implements ISpecDocRepository {
  constructor(
    @inject(WORKFLOW_TOKENS.GitRepository)
    private readonly _gitRepo: IGitRepository
  ) {}

  read(specPath: string): SpecDocument {
    if (!existsSync(specPath)) {
      throw new WorkflowError(
        `Spec file not found: ${specPath}`,
        'SPEC_MALFORMED'
      );
    }
    return parseSpec(readFileSync(specPath, 'utf-8'));
  }

  readAtRef(
    repoPath: string,
    ref: string,
    relPath: string
  ): SpecDocument | null {
    const markdown = this._gitRepo.fileAtRef(repoPath, ref, relPath);
    if (markdown === null) {
      return null;
    }
    return parseSpec(markdown);
  }
}
