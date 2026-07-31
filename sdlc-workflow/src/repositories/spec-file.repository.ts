import { existsSync, mkdirSync, writeFileSync } from 'fs';
import path from 'path';
import { injectable } from 'inversify';
import { WorkflowError } from '../types';

export interface ISpecFileRepository {
  /**
   * Write a spec into `<repoPath>/specs/<prdId>/phase-<phase>-spec.md`
   * (ADR-0008 location). Refuses to overwrite an existing spec — a spec on
   * disk may already be Approved, and clobbering it would erase a gate.
   */
  writeSpec(
    repoPath: string,
    prdId: string,
    phase: number,
    markdown: string
  ): string;
}

@injectable()
export class SpecFileRepository implements ISpecFileRepository {
  writeSpec(
    repoPath: string,
    prdId: string,
    phase: number,
    markdown: string
  ): string {
    const dir = path.join(repoPath, 'specs', prdId);
    const filePath = path.join(dir, `phase-${phase}-spec.md`);

    if (existsSync(filePath)) {
      throw new WorkflowError(
        `Spec already exists: ${filePath} — supersede it explicitly instead of overwriting`,
        'SPEC_EXISTS'
      );
    }

    mkdirSync(dir, { recursive: true });
    writeFileSync(filePath, markdown);
    return filePath;
  }
}
