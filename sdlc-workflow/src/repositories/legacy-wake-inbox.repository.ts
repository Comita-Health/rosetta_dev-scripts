import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync
} from 'fs';
import { injectable } from 'inversify';
import os from 'os';
import path from 'path';

/**
 * One pending file from the pre-PRD-0020 wake inbox
 * (`~/.rosetta/wake/pending/<slug>.json` / `WakeInboxRepository`).
 */
export interface LegacyWakeRecord {
  /** Absolute path of the pending file. */
  filePath: string;
  kind: string;
  dedupeKey: string;
  prompt: string;
  data: Record<string, unknown>;
  createdAt: string;
  pid?: number;
}

/**
 * Filesystem access for the session-era wake inbox that still lives under
 * `$ROSETTA_WAKE_DIR` (default `~/.rosetta/wake`).
 *
 * @remarks
 * The PRD-0020 daemon store is the durable inbox going forward. This
 * repository exists so operators can migrate stranded pending files without
 * the daemon process itself depending on the legacy tree at runtime.
 */
export interface ILegacyWakeInboxRepository {
  /** Absolute root (`…/wake`) — env override or `~/.rosetta/wake`. */
  resolveRoot(wakeDir?: string): string;
  /** Parse every `pending/*.json` that looks like a legacy wake. */
  listPending(wakeDir?: string): LegacyWakeRecord[];
  /**
   * Move a pending file into `consumed/` after a successful migrate.
   * No-op when the source path is already gone (idempotent retries).
   */
  archivePending(filePath: string, wakeDir?: string): void;
}

const defaultWakeRoot = (): string =>
  process.env.ROSETTA_WAKE_DIR ?? path.join(os.homedir(), '.rosetta', 'wake');

@injectable()
export class LegacyWakeInboxRepository implements ILegacyWakeInboxRepository {
  /**
   * Resolve the legacy wake root. Absolute `wakeDir` wins; otherwise
   * `ROSETTA_WAKE_DIR` or `~/.rosetta/wake`.
   */
  resolveRoot(wakeDir?: string): string {
    if (typeof wakeDir === 'string' && wakeDir.trim().length > 0) {
      return path.resolve(wakeDir.trim());
    }
    return path.resolve(defaultWakeRoot());
  }

  /**
   * List parseable pending wakes. Unreadable or malformed JSON files are
   * skipped so one corrupt slug cannot block the whole migrate.
   */
  listPending(wakeDir?: string): LegacyWakeRecord[] {
    const root = this.resolveRoot(wakeDir);
    const pendingDir = path.join(root, 'pending');
    if (existsSync(pendingDir) === false) {
      return [];
    }
    let names: string[] = [];
    try {
      names = readdirSync(pendingDir).filter(name => name.endsWith('.json'));
    } catch {
      return [];
    }
    const records: LegacyWakeRecord[] = [];
    for (const name of names.sort()) {
      const filePath = path.join(pendingDir, name);
      const parsed = this.readRecord(filePath);
      if (parsed !== null) {
        records.push(parsed);
      }
    }
    return records;
  }

  /**
   * Rename `pending/<file>` → `consumed/<file>`. Overwrites an existing
   * consumed peer so a re-migrate of an already-archived slug stays quiet.
   */
  archivePending(filePath: string, wakeDir?: string): void {
    if (existsSync(filePath) === false) {
      return;
    }
    const root = this.resolveRoot(wakeDir);
    const consumedDir = path.join(root, 'consumed');
    mkdirSync(consumedDir, { recursive: true });
    const dest = path.join(consumedDir, path.basename(filePath));
    renameSync(filePath, dest);
  }

  private readRecord(filePath: string): LegacyWakeRecord | null {
    try {
      const parsed: unknown = JSON.parse(readFileSync(filePath, 'utf-8'));
      if (
        typeof parsed !== 'object' ||
        parsed === null ||
        Array.isArray(parsed)
      ) {
        return null;
      }
      const record = parsed as Record<string, unknown>;
      if (
        typeof record.kind !== 'string' ||
        record.kind.trim().length === 0 ||
        typeof record.dedupeKey !== 'string' ||
        record.dedupeKey.trim().length === 0 ||
        typeof record.prompt !== 'string' ||
        typeof record.createdAt !== 'string'
      ) {
        return null;
      }
      const data =
        typeof record.data === 'object' &&
        record.data !== null &&
        Array.isArray(record.data) === false
          ? (record.data as Record<string, unknown>)
          : {};
      return {
        filePath,
        kind: record.kind.trim(),
        dedupeKey: record.dedupeKey.trim(),
        prompt: record.prompt,
        data,
        createdAt: record.createdAt,
        ...(typeof record.pid === 'number' ? { pid: record.pid } : {})
      };
    } catch {
      return null;
    }
  }
}
