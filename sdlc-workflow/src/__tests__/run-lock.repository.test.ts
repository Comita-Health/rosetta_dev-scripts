import fs, {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync
} from 'fs';
import os from 'os';
import path from 'path';
import {
  RunLockRepository,
  type IRunLockRepository
} from '../repositories/run-lock.repository';
import { WorkflowError } from '../types';

/** A pid that cannot be running: pid 0 is never a real user process. */
const DEAD_PID = 0x7fffffff;

describe('RunLockRepository (SPEC-PRD-0021-P1 T-02)', () => {
  let repo: IRunLockRepository;
  let runsDir: string;
  const runId = 'run-1';
  const lockPath = (): string => path.join(runsDir, runId, 'run.lock');

  const writeForeignLock = (overrides: Record<string, unknown> = {}): void => {
    mkdirSync(path.join(runsDir, runId), { recursive: true });
    writeFileSync(
      lockPath(),
      `${JSON.stringify({
        pid: DEAD_PID,
        host: os.hostname(),
        owner: 'run',
        acquiredAt: '2026-08-05T00:00:00Z',
        ...overrides
      })}\n`
    );
  };

  beforeEach(() => {
    repo = new RunLockRepository();
    runsDir = mkdtempSync(path.join(os.tmpdir(), 'sdlc-lock-'));
  });

  afterEach(() => rmSync(runsDir, { recursive: true, force: true }));

  it('acquires an unheld lock and records the owning process', () => {
    const lock = repo.acquire(runsDir, runId, 'run');

    expect(existsSync(lockPath())).toBe(true);
    expect(lock.record).toMatchObject({
      pid: process.pid,
      host: os.hostname(),
      owner: 'run'
    });
    expect(repo.heldByThisProcess(runsDir, runId)).toBe(true);
  });

  // Fail-fast, not queue: waiting would turn a duplicate launch into a
  // silently serialized second run, which is the outcome the lock prevents.
  it('fails fast with RUN_LOCK_HELD when a live writer holds it', () => {
    // A live pid nameable without spawning anything: the parent process.
    writeForeignLock({ pid: process.ppid, owner: 'manual-resume' });

    let caught: WorkflowError | undefined;
    try {
      repo.acquire(runsDir, runId, 'run');
    } catch (err) {
      caught = err as WorkflowError;
    }

    expect(caught?.code).toBe('RUN_LOCK_HELD');
    expect(caught?.details.join(' ')).toContain(String(process.ppid));
    expect(caught?.details.join(' ')).toContain('manual-resume');
    // The message must tell the operator what to do, not just that it failed.
    expect(caught?.details.join(' ')).toContain('already running');
  });

  it('a relaunch and a manual resume racing produce one winner and one fast failure', () => {
    // Two independent instances stand in for the two processes; the exclusive
    // file create decides, not either instance's in-memory state.
    const relaunch = new RunLockRepository();
    const manual = new RunLockRepository();

    const winner = relaunch.acquire(runsDir, runId, 'continuity-relaunch');

    expect(() => manual.acquire(runsDir, runId, 'manual-resume')).toThrow(
      expect.objectContaining({ code: 'RUN_LOCK_HELD' })
    );
    // Exactly one acquisition owns the run, and it is the first one.
    expect(repo.holder(runsDir, runId)).toMatchObject({
      owner: 'continuity-relaunch',
      token: winner.record.token
    });

    // The loser must not have been able to release the winner either.
    relaunch.release(winner);
    expect(existsSync(lockPath())).toBe(false);
  });

  // A SIGKILLed run cannot run a release handler. Without reclaim, every hard
  // kill would leave a run permanently unresumable — the lock outliving the
  // problem it guards against.
  it('reclaims a lock whose owner process is gone', () => {
    writeForeignLock({ pid: DEAD_PID });

    const lock = repo.acquire(runsDir, runId, 'run');

    expect(lock.record.pid).toBe(process.pid);
    expect(repo.heldByThisProcess(runsDir, runId)).toBe(true);
  });

  // A pid on another machine cannot be probed from here. Assuming it dead
  // would let two hosts write one run — worse than a stuck lock a human sees.
  it('never reclaims a lock recorded on a different host', () => {
    writeForeignLock({ pid: DEAD_PID, host: 'some-other-box' });

    expect(() => repo.acquire(runsDir, runId)).toThrow(
      expect.objectContaining({ code: 'RUN_LOCK_HELD' })
    );
  });

  it('treats an unreadable lock file as unheld so a run cannot wedge forever', () => {
    mkdirSync(path.join(runsDir, runId), { recursive: true });
    writeFileSync(lockPath(), 'not json at all');

    expect(repo.holder(runsDir, runId)).toBeNull();
    expect(repo.acquire(runsDir, runId).record.pid).toBe(process.pid);
  });

  it('treats a lock file missing its identity fields as unheld', () => {
    writeForeignLock({ pid: 'not-a-number' });

    expect(repo.holder(runsDir, runId)).toBeNull();
  });

  it('reports no holder and no ownership for a run that was never locked', () => {
    expect(repo.holder(runsDir, runId)).toBeNull();
    expect(repo.heldByThisProcess(runsDir, runId)).toBe(false);
  });

  it('release removes the lock and is idempotent', () => {
    const lock = repo.acquire(runsDir, runId);

    repo.release(lock);
    expect(existsSync(lockPath())).toBe(false);

    expect(() => repo.release(lock)).not.toThrow();
  });

  // Releasing a lock someone else acquired would reopen the very race the
  // lock closed, so ownership is checked against the acquisition, not the path.
  it('release leaves a lock held by a different acquisition alone', () => {
    const stale = repo.acquire(runsDir, runId, 'first');
    repo.release(stale);
    const current = repo.acquire(runsDir, runId, 'second');

    repo.release(stale);

    expect(existsSync(lockPath())).toBe(true);
    expect(repo.holder(runsDir, runId)?.owner).toBe('second');
    repo.release(current);
  });

  it('defaults the owner label to run', () => {
    expect(repo.acquire(runsDir, runId).record.owner).toBe('run');
  });

  it('fills a missing owner label when reading an older lock file', () => {
    writeForeignLock({ pid: process.ppid, owner: undefined });

    expect(repo.holder(runsDir, runId)).toMatchObject({ owner: 'unknown' });
  });

  it('does not claim ownership of a lock held by another pid on this host', () => {
    writeForeignLock({ pid: process.ppid });

    expect(repo.heldByThisProcess(runsDir, runId)).toBe(false);
  });

  it('reads a lock file written before tokens existed', () => {
    writeForeignLock({ pid: process.ppid, token: undefined });

    // No token means no acquisition can claim it, which is the safe default:
    // it can be reported and reclaimed when dead, but never released by us.
    expect(repo.holder(runsDir, runId)).toMatchObject({ token: '' });
  });

  it('refuses without naming an owner when the lock cannot be read or removed', () => {
    // Real shape: a `run.lock` *directory* left by a bad cleanup script. It
    // cannot be parsed and cannot be unlinked, so no owner can be named — the
    // one case where the refusal has to point at the file itself.
    mkdirSync(lockPath(), { recursive: true });

    let caught: WorkflowError | undefined;
    try {
      repo.acquire(runsDir, runId);
    } catch (err) {
      caught = err as WorkflowError;
    }

    expect(caught?.code).toBe('RUN_LOCK_HELD');
    expect(caught?.details[0]).toContain('run.lock');
    // Inventing a pid here would send the operator after the wrong process.
    expect(caught?.details[0]).not.toContain('pid');
  });

  it('propagates a lock-path error that is not contention', () => {
    const spy = jest.spyOn(fs, 'openSync').mockImplementation(() => {
      const err = new Error('read-only file system') as NodeJS.ErrnoException;
      err.code = 'EROFS';
      throw err;
    });

    try {
      // Only EEXIST means "someone else holds it". Swallowing anything else
      // would report a broken disk as a busy run.
      expect(() => repo.acquire(runsDir, runId)).toThrow(
        'read-only file system'
      );
    } finally {
      spy.mockRestore();
    }
  });
});
