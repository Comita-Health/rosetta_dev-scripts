import { mkdtempSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import { DropStateRepository } from '../repositories/drop-state.repository';
import { DropState, WorkflowError } from '../types';

describe('DropStateRepository', () => {
  let dir: string;
  const repo = new DropStateRepository();

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'sdlc-drop-state-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('round-trips drop state and fails loud when missing', () => {
    const state: DropState = {
      dropId: 'ship-1',
      issues: ['org/repo#1'],
      repoPath: '/repo',
      worktreePath: '/wt',
      branch: 'sdlc/drop/ship-1',
      baseSha: 'abc',
      mode: 'direct',
      requireApprove: false,
      tasks: [],
      updatedAt: 'now'
    };
    const written = repo.write(dir, state);
    expect(written).toContain('drop.json');
    expect(repo.load(dir, 'ship-1').dropId).toBe('ship-1');
    expect(() => repo.load(dir, 'missing')).toThrow(WorkflowError);
  });
});
