import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  mkdirSync
} from 'fs';
import os from 'os';
import path from 'path';
import { RunStateRepository } from '../repositories/run-state.repository';
import { SurfaceMapRepository } from '../repositories/surface-map.repository';
import type { RunState } from '../types';

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
  updatedAt: 'x'
});

describe('RunStateRepository', () => {
  const repo = new RunStateRepository();
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

  it('fills fields missing from state files written by older versions', () => {
    const legacy = makeState() as Partial<RunState>;
    delete legacy.exceptions;
    delete legacy.tokenSpendK;
    delete legacy.ciFixAttempts;
    delete legacy.steps;
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
});

describe('SurfaceMapRepository', () => {
  const repo = new SurfaceMapRepository();
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'sdlc-surfaces-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('returns an empty map when no surfaces file exists', () => {
    expect(repo.load(dir)).toEqual({});
  });

  it('loads the surface map from .sdlc/surfaces.json', () => {
    mkdirSync(path.join(dir, '.sdlc'), { recursive: true });
    writeFileSync(
      path.join(dir, '.sdlc', 'surfaces.json'),
      JSON.stringify({ auth: ['src/auth/**'] })
    );
    expect(repo.load(dir)).toEqual({ auth: ['src/auth/**'] });
    expect(
      readFileSync(path.join(dir, '.sdlc', 'surfaces.json'), 'utf-8')
    ).toContain('auth');
  });
});
