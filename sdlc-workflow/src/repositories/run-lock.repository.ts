import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync
} from 'fs';
import { randomBytes } from 'crypto';
import { injectable } from 'inversify';
import os from 'os';
import path from 'path';
import { WorkflowError } from '../types';

/** Identity of whoever currently owns a run's write lock. */
export interface RunLockRecord {
  pid: number;
  host: string;
  /** Human-readable reason, e.g. `run`, `record-merge`, `state-write`. */
  owner: string;
  /**
   * Unique per acquisition, so releasing a stale handle cannot delete a lock
   * that a *later* acquisition took. `pid` + `acquiredAt` is not enough: the
   * same process re-acquiring inside one millisecond yields an identical
   * record, and release would then unlock the live holder.
   */
  token: string;
  acquiredAt: string;
}

/** Handle returned by {@link IRunLockRepository.acquire}; pass to `release`. */
export interface RunLock {
  runsDir: string;
  runId: string;
  file: string;
  record: RunLockRecord;
}

/**
 * Single-writer lock over one run directory (SPEC-PRD-0021-P1 T-02).
 *
 * A continuity-layer relaunch racing a manual resume used to be prevented
 * only by convention, and losing that race corrupted `state.json` in ways
 * that needed hand surgery to undo. This makes the race structurally
 * impossible: acquisition is an exclusive file create, so exactly one caller
 * wins and every other caller fails immediately with `RUN_LOCK_HELD` rather
 * than blocking or clobbering.
 *
 * @remarks
 * Fail-fast is deliberate. Waiting for a lock would turn a duplicate launch
 * into a silently queued second run, which is the outcome the lock exists to
 * prevent — the operator needs to know a supervisor is already live, not to
 * be put in line behind it.
 */
export interface IRunLockRepository {
  /** @throws `WorkflowError` `RUN_LOCK_HELD` when a live owner holds it. */
  acquire(runsDir: string, runId: string, owner?: string): RunLock;
  /** Idempotent: releasing an already-released or foreign lock is a no-op. */
  release(lock: RunLock): void;
  holder(runsDir: string, runId: string): RunLockRecord | null;
  /** True when this OS process is the recorded owner. */
  heldByThisProcess(runsDir: string, runId: string): boolean;
}

const lockFile = (runsDir: string, runId: string): string =>
  path.join(runsDir, runId, 'run.lock');

/**
 * `signal 0` probes for existence without delivering anything. `EPERM` means
 * the pid exists but belongs to another user — alive, and emphatically not
 * ours to reclaim.
 */
const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
};

@injectable()
export class RunLockRepository implements IRunLockRepository {
  acquire(runsDir: string, runId: string, owner = 'run'): RunLock {
    const file = lockFile(runsDir, runId);
    mkdirSync(path.dirname(file), { recursive: true });

    const record: RunLockRecord = {
      pid: process.pid,
      host: os.hostname(),
      owner,
      token: randomBytes(8).toString('hex'),
      acquiredAt: new Date().toISOString()
    };

    if (!this.tryCreate(file, record)) {
      // A crash cannot run a release handler, so a lock whose owner is gone
      // must be reclaimable or every SIGKILLed run would be permanently
      // unresumable — the lock would outlive the problem it guards against.
      // A `null` holder here means the file exists but names no identity —
      // corrupt or truncated. It cannot prove an owner, and treating it as
      // authoritative would wedge the run behind a file nobody owns.
      const existing = this.holder(runsDir, runId);
      if (existing === null || this.reclaimable(existing)) {
        try {
          unlinkSync(file);
        } catch {
          // Another process reclaimed it first; the retry below decides.
        }
      }
      if (!this.tryCreate(file, record)) {
        const live = this.holder(runsDir, runId);
        throw new WorkflowError(
          `run ${runId} is already locked by another writer`,
          'RUN_LOCK_HELD',
          [
            live === null
              ? `lock file ${file} exists`
              : `held by pid ${live.pid} on ${live.host} (${live.owner}) since ${live.acquiredAt}`,
            'a supervisor or resume is already running for this run — stop it, or wait for it to finish, rather than starting a second writer'
          ]
        );
      }
    }

    return { runsDir, runId, file, record };
  }

  release(lock: RunLock): void {
    const current = this.holder(lock.runsDir, lock.runId);
    if (current === null) return;
    // Releasing someone else's lock would reopen the race the lock closed.
    if (current.token !== lock.record.token) return;
    try {
      unlinkSync(lock.file);
    } catch {
      // Already gone — the desired end state either way.
    }
  }

  holder(runsDir: string, runId: string): RunLockRecord | null {
    const file = lockFile(runsDir, runId);
    if (!existsSync(file)) return null;
    try {
      const parsed = JSON.parse(
        readFileSync(file, 'utf-8')
      ) as Partial<RunLockRecord>;
      if (typeof parsed.pid !== 'number' || typeof parsed.host !== 'string') {
        return null;
      }
      return {
        pid: parsed.pid,
        host: parsed.host,
        owner: parsed.owner ?? 'unknown',
        token: parsed.token ?? '',
        acquiredAt: parsed.acquiredAt ?? ''
      };
    } catch {
      // An unreadable lock file cannot prove an owner. Treating it as
      // unheld lets a reclaim clear it instead of wedging the run forever.
      return null;
    }
  }

  heldByThisProcess(runsDir: string, runId: string): boolean {
    const current = this.holder(runsDir, runId);
    return (
      current !== null &&
      current.pid === process.pid &&
      current.host === os.hostname()
    );
  }

  /** Exclusive create: the kernel picks the winner, not our read-then-write. */
  private tryCreate(file: string, record: RunLockRecord): boolean {
    let fd: number;
    try {
      fd = openSync(file, 'wx');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw err;
    }
    try {
      writeSync(fd, `${JSON.stringify(record)}\n`);
    } finally {
      closeSync(fd);
    }
    return true;
  }

  /**
   * Only a dead owner on *this* host is reclaimable. A pid on another host
   * cannot be probed from here, so assuming it dead would let two machines
   * write the same run — a worse failure than a stuck lock an operator can
   * see and delete.
   *
   * @remarks
   * Our own pid is deliberately *not* reclaimable. Every legitimate re-entry
   * from the holding process goes through `heldByThisProcess` instead, so a
   * same-pid acquire means a second writer inside one process — exactly what
   * a self-reclaim would hide.
   */
  private reclaimable(record: RunLockRecord): boolean {
    if (record.host !== os.hostname()) return false;
    return !pidAlive(record.pid);
  }
}
