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
import { RunState } from '../types';

const makeState = (): RunState => ({
  runId: 'run-1',
  specId: 'SPEC-PRD-0099-P2',
  specPath: '/specs/spec.md',
  baseSha: 'base',
  taskResults: {},
  verdicts: [],
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
