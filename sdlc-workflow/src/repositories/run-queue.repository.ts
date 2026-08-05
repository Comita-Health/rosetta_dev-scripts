import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync
} from 'fs';
import { injectable } from 'inversify';
import path from 'path';

/**
 * A durable run-launch record — the T-02 interim consumer's contract, later
 * owned by the PRD-0020 daemon's watch registry unchanged. Captures the same
 * argv surface as the continuity daemon's `launch.json` (`argv`, `execArgv`,
 * `execPath`, `cwd`) so a detached relaunch needs nothing beyond this file.
 */
export interface QueuedLaunchRecord {
  /** Absolute path — the dedup key (one queued launch per spec). */
  specPath: string;
  repoPath: string;
  runsDir: string;
  runId?: string;
  /** Full `run …` argv (argv[0] is a placeholder `'node'` entry — matches
   * `process.argv`'s shape so `buildSuperviseChildArgv` can consume it
   * unchanged). */
  argv: string[];
  execArgv: string[];
  execPath: string;
  cwd: string;
  queuedAt: string; // ISO timestamp
}

export interface QueueEnqueueResult {
  /** True when an existing record for this spec path was found — no file
   * was written (FIFO dedup by spec path). */
  deduped: boolean;
  /** Path of the written (or, when deduped, pre-existing) record file. */
  path: string;
  /** FIFO sequence number of the record. */
  seq: number;
}

export interface QueuedEntry {
  seq: number;
  record: QueuedLaunchRecord;
}

/**
 * `<runsDir>/queue/<n>.json` FIFO of {@link QueuedLaunchRecord}s (T-02). The
 * ascending numeric filename is the ordering — `list`/`peek` never rely on
 * file mtimes, which a filesystem can coalesce under fast writes.
 */
export interface IRunQueueRepository {
  /** Append a record; a no-op (returns `deduped: true`) when a record for
   * the same `specPath` is already queued. */
  enqueue(
    runsDir: string,
    record: Omit<QueuedLaunchRecord, 'queuedAt'>
  ): QueueEnqueueResult;
  /** Every queued record, oldest first. */
  list(runsDir: string): QueuedEntry[];
  /** The oldest queued record, or null when the queue is empty. */
  peek(runsDir: string): QueuedEntry | null;
  /** Remove a record by its sequence number (no-op if already gone). */
  remove(runsDir: string, seq: number): void;
}

const queueDir = (runsDir: string): string => path.join(runsDir, 'queue');

const seqFromName = (name: string): number | null => {
  const match = /^(\d+)\.json$/.exec(name);
  return match === null ? null : Number(match[1]);
};

@injectable()
export class RunQueueRepository implements IRunQueueRepository {
  enqueue(
    runsDir: string,
    record: Omit<QueuedLaunchRecord, 'queuedAt'>
  ): QueueEnqueueResult {
    const dir = queueDir(runsDir);
    mkdirSync(dir, { recursive: true });

    const existing = this.list(runsDir).find(
      entry => path.resolve(entry.record.specPath) === path.resolve(record.specPath)
    );
    if (existing !== undefined) {
      return {
        deduped: true,
        path: path.join(dir, `${existing.seq}.json`),
        seq: existing.seq
      };
    }

    const seq = this.nextSeq(runsDir);
    const file = path.join(dir, `${seq}.json`);
    const full: QueuedLaunchRecord = {
      ...record,
      queuedAt: new Date().toISOString()
    };
    writeFileSync(file, JSON.stringify(full, null, 2));
    return { deduped: false, path: file, seq };
  }

  list(runsDir: string): QueuedEntry[] {
    const dir = queueDir(runsDir);
    if (!existsSync(dir)) {
      return [];
    }
    const seqs = readdirSync(dir)
      .map(seqFromName)
      .filter((seq): seq is number => seq !== null)
      .sort((a, b) => a - b);
    return seqs.map(seq => ({
      seq,
      record: JSON.parse(
        readFileSync(path.join(dir, `${seq}.json`), 'utf-8')
      ) as QueuedLaunchRecord
    }));
  }

  peek(runsDir: string): QueuedEntry | null {
    const entries = this.list(runsDir);
    return entries.length > 0 ? entries[0] : null;
  }

  remove(runsDir: string, seq: number): void {
    const file = path.join(queueDir(runsDir), `${seq}.json`);
    if (existsSync(file)) {
      unlinkSync(file);
    }
  }

  private nextSeq(runsDir: string): number {
    const dir = queueDir(runsDir);
    if (!existsSync(dir)) {
      return 1;
    }
    const seqs = readdirSync(dir)
      .map(seqFromName)
      .filter((seq): seq is number => seq !== null);
    return seqs.length === 0 ? 1 : Math.max(...seqs) + 1;
  }
}
