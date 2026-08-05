import { existsSync, mkdirSync, writeFileSync } from 'fs';
import path from 'path';
import { injectable } from 'inversify';
import { WorkflowError } from '../types';
import { isSpecTreePath } from '../utils/spec-path';

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
  /**
   * The single privileged route for rewriting an existing spec
   * (SPEC-PRD-0023-P1 T-03 / S-05). Overwrites `relPath` inside `checkoutPath`
   * with derived closeout content.
   *
   * @remarks
   * Unlike {@link ISpecFileRepository.writeSpec} this deliberately *does*
   * overwrite, which is why it is separate and why it must stay
   * single-caller: `specs/**` is a hard envelope breach for every agent diff,
   * and the closeout generator is the one writer allowed through. A second
   * call site is a policy change, not a refactor — `spec-closeout.test.ts`
   * pins the caller count so adding one fails the suite. Refuses an absolute
   * path or one that escapes the checkout, refuses a path outside a `specs/`
   * tree, and refuses to create a spec that is not already there (closeout
   * amends the Approved document; it never authors one).
   */
  writeCloseout(
    checkoutPath: string,
    relPath: string,
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

  writeCloseout(
    checkoutPath: string,
    relPath: string,
    markdown: string
  ): string {
    const normalized = path
      .normalize(relPath.split(path.sep).join('/'))
      .split(path.sep)
      .join('/');
    if (path.isAbsolute(relPath) || normalized.startsWith('..')) {
      throw new WorkflowError(
        `closeout target must be a path inside the checkout, not ${relPath}`,
        'SPEC_INVALID'
      );
    }
    if (!isSpecTreePath(normalized)) {
      throw new WorkflowError(
        `closeout may only write under a specs/ tree, not ${relPath}`,
        'SPEC_INVALID'
      );
    }
    const filePath = path.join(checkoutPath, normalized);
    if (!existsSync(filePath)) {
      throw new WorkflowError(
        `closeout target does not exist: ${filePath}`,
        'SPEC_INVALID'
      );
    }
    writeFileSync(filePath, markdown);
    return filePath;
  }
}
