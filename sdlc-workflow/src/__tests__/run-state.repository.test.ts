import fs, {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'fs';
import os from 'os';
import path from 'path';
import { RunStateRepository } from '../repositories/run-state.repository';
import { RunLockRepository } from '../repositories/run-lock.repository';
import type { RunState, WorkflowError } from '../types';

const makeState = (): RunState => ({
  runId: 'run-1',
  specId: 'SPEC-PRD-0099-P2',
  specPath: '/specs/spec.md',
  baseSha: 'base',
  taskResults: {},
  verdicts: [],
  exceptions: [],
  criterionVerdicts: [],
  steps: {},
  tokenSpendK: 0,
  ciFixAttempts: {},
  gateFixAttempts: {},
  remediations: {},
  mergeBlockedRetries: 0,
  updatedAt: 'x'
});

describe('RunStateRepository', () => {
  const repo = new RunStateRepository(new RunLockRepository());
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'sdlc-state-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('returns null for an unknown run', () => {
    expect(repo.load(dir, 'nope')).toBeNull();
  });

  it('round-trips run state and refreshes updatedAt', () => {
    const file = repo.save(dir, makeState());
    expect(file).toBe(path.join(dir, 'run-1', 'state.json'));

    const loaded = repo.load(dir, 'run-1');
    expect(loaded?.specId).toBe('SPEC-PRD-0099-P2');
    expect(loaded?.updatedAt).not.toBe('x');
  });

  it('appends verdicts and records task results persistently', () => {
    const state = makeState();
    repo.appendVerdict(dir, state, {
      gate: 'envelope',
      outcome: 'breach',
      wouldEscalate: true,
      reasons: ['r'],
      recordedAt: 'x'
    });
    repo.recordTaskResult(dir, state, {
      taskId: 'T-01',
      status: 'completed',
      recordedAt: 'x'
    });

    const loaded = repo.load(dir, 'run-1');
    expect(loaded?.verdicts).toHaveLength(1);
    expect(loaded?.verdicts[0].wouldEscalate).toBe(true);
    expect(loaded?.taskResults['T-01'].status).toBe('completed');
  });

  it('preserves mergedSha and prUrl when re-recording a task result', () => {
    const state = makeState();
    repo.recordTaskResult(dir, state, {
      taskId: 'T-02',
      status: 'completed',
      mergedSha: 'merge-sha',
      prUrl: 'https://example.com/pr/1',
      inputsDigest: 'old',
      recordedAt: 'x'
    });
    repo.recordTaskResult(dir, state, {
      taskId: 'T-02',
      status: 'completed',
      inputsDigest: 'new-tip-digest',
      recordedAt: 'y'
    });

    const loaded = repo.load(dir, 'run-1');
    expect(loaded?.taskResults['T-02']).toMatchObject({
      inputsDigest: 'new-tip-digest',
      mergedSha: 'merge-sha',
      prUrl: 'https://example.com/pr/1'
    });
  });

  it('records exception-ledger entries persistently', () => {
    const state = makeState();
    repo.recordExceptions(dir, state, [
      {
        trigger: 'budget-exhaustion',
        taskId: 'T-01',
        context: ['token spend 250k exceeds budget 200k'],
        recordedAt: 'x'
      }
    ]);

    const loaded = repo.load(dir, 'run-1');
    expect(loaded?.exceptions).toHaveLength(1);
    expect(loaded?.exceptions[0].trigger).toBe('budget-exhaustion');
  });

  it('does not write when there are no exceptions to record', () => {
    const state = makeState();
    repo.recordExceptions(dir, state, []);
    expect(repo.load(dir, 'run-1')).toBeNull();
  });

  it('records the latest sandbox deploy, replacing the previous one', () => {
    const state = makeState();
    repo.recordSandbox(dir, state, {
      sha: 'first',
      status: 'healthy',
      recordedAt: 'x'
    });
    repo.recordSandbox(dir, state, {
      sha: 'second',
      status: 'failed',
      recordedAt: 'y'
    });

    // One current deploy, not a history: the sandbox gate judges what is
    // deployed now, and a stale healthy record would read as green.
    expect(repo.load(dir, 'run-1')?.sandbox).toEqual({
      sha: 'second',
      status: 'failed',
      recordedAt: 'y'
    });
  });

  it('appends criterion verdicts and skips the write when there are none', () => {
    const state = makeState();
    repo.recordCriteria(dir, state, [
      {
        taskId: 'T-01',
        criterion: 'test: x',
        tier: 'test',
        outcome: 'pass',
        recordedAt: 'x'
      }
    ]);
    expect(repo.load(dir, 'run-1')?.criterionVerdicts).toHaveLength(1);

    const before = repo.load(dir, 'run-1')?.updatedAt;
    repo.recordCriteria(dir, state, []);
    expect(repo.load(dir, 'run-1')?.updatedAt).toBe(before);
  });

  it('fills fields missing from state files written by older versions', () => {
    const legacy = makeState() as Partial<RunState>;
    delete legacy.exceptions;
    delete legacy.tokenSpendK;
    delete legacy.ciFixAttempts;
    delete legacy.steps;
    delete legacy.startedAt;
    delete legacy.specDigest;
    delete legacy.launchArgv;
    mkdirSync(path.join(dir, 'run-1'), { recursive: true });
    writeFileSync(
      path.join(dir, 'run-1', 'state.json'),
      JSON.stringify(legacy)
    );

    const loaded = repo.load(dir, 'run-1');
    expect(loaded?.exceptions).toEqual([]);
    expect(loaded?.tokenSpendK).toBe(0);
    expect(loaded?.ciFixAttempts).toEqual({});
    expect(loaded?.steps).toEqual({});
    expect(loaded?.startedAt).toBe(legacy.updatedAt);
    expect(loaded?.specDigest).toBe('');
    expect(loaded?.launchArgv).toEqual([]);
  });

  it('records step results under their cache key (T-09)', () => {
    const state = makeState();
    repo.recordStep(dir, state, 'envelope:T-01:abc', {
      name: 'envelope',
      taskId: 'T-01',
      inputsDigest: 'abc',
      completedAt: 'x'
    });

    const loaded = repo.load(dir, 'run-1');
    expect(loaded?.steps['envelope:T-01:abc']).toEqual(
      expect.objectContaining({ name: 'envelope', inputsDigest: 'abc' })
    );
  });

  it('records the human-approved merged SHA (T-08)', () => {
    const state = makeState();
    repo.recordMergedSha(dir, state, 'abc123');

    const loaded = repo.load(dir, 'run-1');
    expect(loaded?.mergedSha).toBe('abc123');
  });

  it('records a per-task merge, and no-ops for an unknown task (P3 T-01)', () => {
    const state = makeState();
    state.taskResults['T-01'] = {
      taskId: 'T-01',
      status: 'completed',
      recordedAt: 'x'
    };
    repo.save(dir, state);

    repo.recordTaskMerged(dir, state, 'T-01', 'merge-sha');
    expect(repo.load(dir, 'run-1')?.taskResults['T-01'].mergedSha).toBe(
      'merge-sha'
    );

    repo.recordTaskMerged(dir, state, 'T-99', 'other-sha');
    expect(repo.load(dir, 'run-1')?.taskResults['T-99']).toBeUndefined();
  });

  it('records a task PR URL (P3 T-02)', () => {
    const state = makeState();
    state.taskResults['T-01'] = {
      taskId: 'T-01',
      status: 'completed',
      recordedAt: 'x'
    };
    repo.save(dir, state);

    repo.recordTaskPrUrl(dir, state, 'T-01', 'https://github.com/o/r/pull/3');
    expect(repo.load(dir, 'run-1')?.taskResults['T-01'].prUrl).toBe(
      'https://github.com/o/r/pull/3'
    );

    repo.recordTaskPrUrl(dir, state, 'T-99', 'https://github.com/o/r/pull/4');
    expect(repo.load(dir, 'run-1')?.taskResults['T-99']).toBeUndefined();
  });

  it('increments and persists CI fix attempts (P3 T-03)', () => {
    const state = makeState();
    repo.save(dir, state);

    expect(repo.recordCiFixAttempt(dir, state, 'T-01')).toBe(1);
    expect(repo.recordCiFixAttempt(dir, state, 'T-01')).toBe(2);

    // Persisted: a resumed run never resets the budget.
    expect(repo.load(dir, 'run-1')?.ciFixAttempts['T-01']).toBe(2);
  });

  it('accumulates and persists token spend (P3 T-06)', () => {
    const state = makeState();
    repo.save(dir, state);

    expect(repo.recordTokenSpend(dir, state, 5)).toBe(5);
    expect(repo.recordTokenSpend(dir, state, 3)).toBe(8);
    expect(repo.load(dir, 'run-1')?.tokenSpendK).toBe(8);
  });

  describe('Wave 0 retry bookkeeping', () => {
    it('increments and persists gate fix attempts', () => {
      const state = makeState();
      repo.save(dir, state);

      expect(repo.recordGateFixAttempt(dir, state, 'T-01')).toBe(1);
      expect(repo.recordGateFixAttempt(dir, state, 'T-01')).toBe(2);
      expect(repo.recordGateFixAttempt(dir, state, 'T-02')).toBe(1);

      // Persisted: a resume must not refill the remediation budget.
      const loaded = repo.load(dir, 'run-1');
      expect(loaded?.gateFixAttempts).toEqual({ 'T-01': 2, 'T-02': 1 });
    });

    it('records a remediation with the attempt, head SHA and gates', () => {
      const state = makeState();
      repo.recordGateFixAttempt(dir, state, 'T-01');
      repo.recordRemediation(dir, state, 'T-01', 'fix-sha', [
        'reviewer',
        'envelope'
      ]);

      const record = repo.load(dir, 'run-1')?.remediations['T-01'];
      expect(record).toMatchObject({
        attempt: 1,
        sha: 'fix-sha',
        gates: ['reviewer', 'envelope']
      });
      expect(record?.recordedAt).toMatch(/^\d{4}-/);
    });

    it('increments and persists merge-blocked retries', () => {
      const state = makeState();
      repo.save(dir, state);

      expect(repo.recordMergeBlockedRetry(dir, state)).toBe(1);
      expect(repo.recordMergeBlockedRetry(dir, state)).toBe(2);
      expect(repo.load(dir, 'run-1')?.mergeBlockedRetries).toBe(2);
    });

    it('recordTaskMerged zeros mergeBlockedRetries so resume is not stuck exhausted (#79)', () => {
      const state = makeState();
      state.mergeBlockedRetries = 3;
      state.taskResults['T-01'] = {
        taskId: 'T-01',
        status: 'completed',
        recordedAt: 'x'
      };
      repo.save(dir, state);

      repo.recordTaskMerged(dir, state, 'T-01', 'merge-sha');

      const loaded = repo.load(dir, 'run-1');
      expect(loaded?.taskResults['T-01'].mergedSha).toBe('merge-sha');
      expect(loaded?.mergeBlockedRetries).toBe(0);
    });

    it('invalidates only the steps matching the predicate, and persists', () => {
      const state = makeState();
      const step = (name: string, taskId: string) => ({
        name,
        taskId,
        inputsDigest: 'd',
        completedAt: 'x'
      });
      state.steps = {
        'ci:T-01:d': step('ci', 'T-01'),
        'phase:T-01:d': step('phase', 'T-01'),
        'reviewer:T-01:d': step('reviewer', 'T-01'),
        'ci:T-02:d': step('ci', 'T-02')
      };
      repo.save(dir, state);

      const removed = repo.invalidateSteps(
        dir,
        state,
        s => s.taskId === 'T-01' && s.name !== 'reviewer'
      );

      expect(removed.sort()).toEqual(['ci:T-01:d', 'phase:T-01:d']);
      expect(Object.keys(repo.load(dir, 'run-1')?.steps ?? {}).sort()).toEqual([
        'ci:T-02:d',
        'reviewer:T-01:d'
      ]);
    });

    it('does not rewrite state when the predicate matches nothing', () => {
      const state = makeState();
      state.steps = {
        'ci:T-01:d': {
          name: 'ci',
          taskId: 'T-01',
          inputsDigest: 'd',
          completedAt: 'x'
        }
      };
      repo.save(dir, state);
      const before = repo.load(dir, 'run-1')?.updatedAt;

      expect(repo.invalidateSteps(dir, state, () => false)).toEqual([]);
      expect(repo.load(dir, 'run-1')?.updatedAt).toBe(before);
    });

    it('backfills the Wave 0 fields for a state file written before them', () => {
      const legacy = {
        runId: 'run-legacy',
        specId: 'S',
        specPath: '/s.md',
        baseSha: 'b',
        taskResults: {},
        verdicts: [],
        updatedAt: '2026-01-01T00:00:00.000Z'
      };
      mkdirSync(path.join(dir, 'run-legacy'), { recursive: true });
      writeFileSync(
        path.join(dir, 'run-legacy', 'state.json'),
        JSON.stringify(legacy)
      );

      const loaded = repo.load(dir, 'run-legacy');
      expect(loaded?.gateFixAttempts).toEqual({});
      expect(loaded?.remediations).toEqual({});
      expect(loaded?.mergeBlockedRetries).toBe(0);
    });
  });

  // SPEC-PRD-0021-P1 T-01 / T-02. Every recovery mechanism in the engine
  // assumes state.json survived the last write; before this it did not have
  // to, and a torn or clobbered file needed hand surgery to undo.
  describe('crash-safe, single-writer writes (Wave 1)', () => {
    const stateFile = (runId = 'run-1'): string =>
      path.join(dir, runId, 'state.json');

    it('writes through a temp file and rename, leaving no scratch file', () => {
      repo.save(dir, makeState());

      const entries = readdirSync(path.join(dir, 'run-1'));
      expect(entries).toContain('state.json');
      expect(entries.filter(entry => entry.includes('.tmp.'))).toEqual([]);
    });

    it('leaves the previous state parseable when a write throws mid-flight', () => {
      const state = makeState();
      state.specId = 'SPEC-ORIGINAL';
      repo.save(dir, state);

      // Stand in for a kill during the write: the rename never happens.
      const spy = jest.spyOn(fs, 'renameSync').mockImplementation(() => {
        throw new Error('killed mid-write');
      });
      try {
        state.specId = 'SPEC-CLOBBERED';
        expect(() => repo.save(dir, state)).toThrow('killed mid-write');
      } finally {
        spy.mockRestore();
      }

      // Not merely present — the *previous valid* content, fully parseable.
      expect(JSON.parse(readFileSync(stateFile(), 'utf-8')).specId).toBe(
        'SPEC-ORIGINAL'
      );
    });

    it('a reader interleaved with writes never sees a partial file', () => {
      const state = makeState();
      repo.save(dir, state);

      // Rename is atomic, so every read lands on one complete document —
      // an in-place write would expose a truncated prefix here.
      for (let index = 0; index < 40; index += 1) {
        state.tokenSpendK = index;
        repo.save(dir, state);
        const observed = JSON.parse(readFileSync(stateFile(), 'utf-8'));
        expect(observed.runId).toBe('run-1');
        expect(typeof observed.tokenSpendK).toBe('number');
      }
    });

    it('refuses to write when another live process holds the run lock', () => {
      mkdirSync(path.join(dir, 'run-1'), { recursive: true });
      writeFileSync(
        path.join(dir, 'run-1', 'run.lock'),
        `${JSON.stringify({
          pid: process.ppid,
          host: os.hostname(),
          owner: 'run',
          token: 'abc',
          acquiredAt: '2026-08-05T00:00:00Z'
        })}\n`
      );

      let caught: WorkflowError | undefined;
      try {
        repo.save(dir, makeState());
      } catch (err) {
        caught = err as WorkflowError;
      }

      expect(caught?.code).toBe('RUN_LOCK_NOT_HELD');
      // Naming the holder is the difference between an actionable refusal
      // and an operator deleting a lock file to see what happens.
      expect(caught?.details.join(' ')).toContain(String(process.ppid));
      expect(existsSync(stateFile())).toBe(false);
    });

    it('writes directly when this process already holds the session lock', () => {
      const lockRepo = new RunLockRepository();
      const lock = lockRepo.acquire(dir, 'run-1', 'run');
      try {
        repo.save(dir, makeState());

        expect(repo.load(dir, 'run-1')?.runId).toBe('run-1');
        // The session lock survives the write: a momentary lock's release
        // must not drop a lock the caller owns for the whole run.
        expect(lockRepo.heldByThisProcess(dir, 'run-1')).toBe(true);
      } finally {
        lockRepo.release(lock);
      }
    });

    it('leaves no lock behind after a lockless write', () => {
      repo.save(dir, makeState());

      expect(existsSync(path.join(dir, 'run-1', 'run.lock'))).toBe(false);
    });

    it('says so plainly when the lock holder cannot be identified', () => {
      // A `run.lock` directory left by a bad cleanup script: acquisition fails
      // for a reason that is not contention, and there is no record to read.
      mkdirSync(path.join(dir, 'run-1', 'run.lock'), { recursive: true });

      let caught: WorkflowError | undefined;
      try {
        repo.save(dir, makeState());
      } catch (err) {
        caught = err as WorkflowError;
      }

      expect(caught?.code).toBe('RUN_LOCK_NOT_HELD');
      expect(caught?.details[0]).toBe('lock holder could not be identified');
      // The underlying cause travels with it — "could not be identified" alone
      // does not tell an operator where to look.
      expect(caught?.details[1]).toContain('run.lock');
      expect(existsSync(stateFile())).toBe(false);
    });

    it('releases the momentary lock even when the write fails', () => {
      const spy = jest.spyOn(fs, 'renameSync').mockImplementation(() => {
        throw new Error('disk full');
      });
      try {
        expect(() => repo.save(dir, makeState())).toThrow('disk full');
      } finally {
        spy.mockRestore();
      }

      // A leaked lock would make the next attempt fail for the wrong reason.
      expect(existsSync(path.join(dir, 'run-1', 'run.lock'))).toBe(false);
    });
  });
});
