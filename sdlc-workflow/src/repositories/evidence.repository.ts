import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { injectable } from 'inversify';
import path from 'path';

/**
 * Persists evidence artifacts (test output, verifier transcripts) under
 * `<runsDir>/<runId>/evidence/<evidenceId>.txt`. Criterion verdicts
 * reference artifacts by stable ID so T-08 can commit them to the
 * Chronicle (SPEC-PRD-0011-P2 T-04: evidence is first-class).
 */
export interface IEvidenceRepository {
  save(
    runsDir: string,
    runId: string,
    evidenceId: string,
    content: string
  ): string;
  load(runsDir: string, runId: string, evidenceId: string): string | null;
}

const evidenceFile = (
  runsDir: string,
  runId: string,
  evidenceId: string
): string => path.join(runsDir, runId, 'evidence', `${evidenceId}.txt`);

@injectable()
export class EvidenceRepository implements IEvidenceRepository {
  save(
    runsDir: string,
    runId: string,
    evidenceId: string,
    content: string
  ): string {
    const file = evidenceFile(runsDir, runId, evidenceId);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
    return file;
  }

  load(runsDir: string, runId: string, evidenceId: string): string | null {
    const file = evidenceFile(runsDir, runId, evidenceId);
    if (!existsSync(file)) return null;
    return readFileSync(file, 'utf-8');
  }
}
