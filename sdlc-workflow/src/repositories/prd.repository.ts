import { existsSync, readdirSync, readFileSync } from 'fs';
import path from 'path';
import { injectable } from 'inversify';
import { ParsedPrd, WorkflowError } from '../types';
import { parsePrd } from '../utils/prd-parser';

export interface IPrdRepository {
  /** Resolve a PRD by ID (e.g. 'PRD-0011') from a docs directory. */
  getPrd(prdId: string, docsDir: string): Promise<ParsedPrd>;
}

@injectable()
export class PrdRepository implements IPrdRepository {
  async getPrd(prdId: string, docsDir: string): Promise<ParsedPrd> {
    if (!existsSync(docsDir)) {
      throw new WorkflowError(
        `PRD docs directory not found: ${docsDir}`,
        'PRD_NOT_FOUND'
      );
    }

    const fileName = readdirSync(docsDir).find(
      f => f.startsWith(`${prdId}-`) && f.endsWith('.md')
    );
    if (!fileName) {
      throw new WorkflowError(
        `No PRD file matching ${prdId}-*.md in ${docsDir}`,
        'PRD_NOT_FOUND'
      );
    }

    const markdown = readFileSync(path.join(docsDir, fileName), 'utf-8');
    return parsePrd(markdown);
  }
}
