import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { injectable } from 'inversify';
import path from 'path';

/**
 * Terminal record written under `<runsDir>/<runId>/supervise.exit` when a
 * supervise / detached child ends (#38 / fail-loud T-02).
 *
 * `abnormal` distinguishes legitimate all-merged completion (`code: 0`,
 * `abnormal: false`) from a zero-exit that left work incomplete (`code: 0`,
 * `abnormal: true`) — readable from artifacts alone without the process.
 */
export interface SuperviseExitRecord {
  code: number;
  reason: string;
  abnormal: boolean;
  at: string;
}

export interface ISuperviseExitRepository {
  write(runDir: string, record: SuperviseExitRecord): string;
  read(runDir: string): SuperviseExitRecord | null;
}

const exitFile = (runDir: string): string =>
  path.join(runDir, 'supervise.exit');

@injectable()
export class SuperviseExitRepository implements ISuperviseExitRepository {
  write(runDir: string, record: SuperviseExitRecord): string {
    mkdirSync(runDir, { recursive: true });
    const file = exitFile(runDir);
    writeFileSync(file, `${JSON.stringify(record)}\n`);
    return file;
  }

  read(runDir: string): SuperviseExitRecord | null {
    const file = exitFile(runDir);
    if (!existsSync(file)) {
      return null;
    }
    try {
      const raw = readFileSync(file, 'utf-8').trim();
      // Continuity daemon may overwrite with a bare integer after a relaunch
      // probe; accept both shapes so operators can still inspect the file.
      if (/^-?\d+$/.test(raw)) {
        const code = Number(raw);
        return {
          code,
          reason: 'daemon-probe',
          abnormal: code !== 0,
          at: new Date(0).toISOString()
        };
      }
      const parsed = JSON.parse(raw) as Partial<SuperviseExitRecord>;
      if (
        typeof parsed.code !== 'number' ||
        typeof parsed.reason !== 'string' ||
        typeof parsed.abnormal !== 'boolean' ||
        typeof parsed.at !== 'string'
      ) {
        return null;
      }
      return {
        code: parsed.code,
        reason: parsed.reason,
        abnormal: parsed.abnormal,
        at: parsed.at
      };
    } catch {
      return null;
    }
  }
}
