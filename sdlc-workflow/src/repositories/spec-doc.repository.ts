import { existsSync, readFileSync } from 'fs';
import { injectable } from 'inversify';
import { SpecDocument, WorkflowError } from '../types';
import { parseSpec } from '../utils/spec-parser';

/** Reads an ADR-0008 implementation spec file into a typed document. */
export interface ISpecDocRepository {
  read(specPath: string): SpecDocument;
}

@injectable()
export class SpecDocRepository implements ISpecDocRepository {
  read(specPath: string): SpecDocument {
    if (!existsSync(specPath)) {
      throw new WorkflowError(
        `Spec file not found: ${specPath}`,
        'SPEC_MALFORMED'
      );
    }
    return parseSpec(readFileSync(specPath, 'utf-8'));
  }
}
