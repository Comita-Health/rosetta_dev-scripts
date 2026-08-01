import { execSync } from 'child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync
} from 'fs';
import { injectable } from 'inversify';
import path from 'path';
import { ChronicleArtifact, WorkflowError } from '../types';

/**
 * Writes SPEC-PRD-0011-P2 run outputs into a Chronicle ledger repo as
 * versioned JSON artifacts under `chronicles/sdlc/<runId>/`, committed per
 * ADR-0007: `chronicle(<scope>): <subject>` with mandatory
 * `Chronicle-Window:` and `Generated-By:` trailers. Machine authorship is
 * marked by the commit type; activity collection self-excludes it.
 */
export interface IChronicleArtifactRepository {
  /** Write one artifact; returns the repo-relative path. */
  writeArtifact(
    chronicleRepo: string,
    runId: string,
    name: string,
    artifact: ChronicleArtifact
  ): string;
  /** Read all artifacts of a run back (gate-policy consumption). */
  readArtifacts(chronicleRepo: string, runId: string): ChronicleArtifact[];
  /**
   * Stage `chronicles/` and commit as `chronicle(<scope>): <subject>` with
   * ADR-0007 trailers. A clean tree is a no-op (idempotent for resume).
   */
  commit(chronicleRepo: string, scope: string, subject: string): void;
}

const GENERATED_BY = 'sdlc-workflow@0.1.0';

const runDir = (chronicleRepo: string, runId: string): string =>
  path.join(chronicleRepo, 'chronicles', 'sdlc', runId);

@injectable()
export class ChronicleArtifactRepository implements IChronicleArtifactRepository {
  writeArtifact(
    chronicleRepo: string,
    runId: string,
    name: string,
    artifact: ChronicleArtifact
  ): string {
    const dir = runDir(chronicleRepo, runId);
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${name}.json`);
    writeFileSync(file, JSON.stringify(artifact, null, 2));
    return path.relative(chronicleRepo, file);
  }

  readArtifacts(chronicleRepo: string, runId: string): ChronicleArtifact[] {
    const dir = runDir(chronicleRepo, runId);
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter(name => name.endsWith('.json'))
      .sort()
      .map(
        name =>
          JSON.parse(
            readFileSync(path.join(dir, name), 'utf-8')
          ) as ChronicleArtifact
      );
  }

  commit(chronicleRepo: string, scope: string, subject: string): void {
    const git = (args: string): string => {
      try {
        return execSync(`git -C "${chronicleRepo}" ${args}`, {
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'pipe']
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new WorkflowError('chronicle commit failed', 'GIT_FAILED', [
          message.slice(0, 500)
        ]);
      }
    };

    git('add chronicles');
    const staged = git('diff --cached --name-only').trim();
    if (staged.length === 0) return;

    const window = new Date().toISOString().slice(0, 10);
    const message = [
      `chronicle(${scope}): ${subject}`,
      '',
      `Chronicle-Window: ${window}`,
      `Generated-By: ${GENERATED_BY}`
    ].join('\n');
    git(`commit -m "${message.replace(/"/g, '\\"')}"`);
  }
}
