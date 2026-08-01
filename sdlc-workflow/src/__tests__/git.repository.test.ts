import 'reflect-metadata';

jest.mock('child_process', () => ({ execSync: jest.fn() }));

import { execSync } from 'child_process';
import os from 'os';
import { GitRepository } from '../repositories/git.repository';

const execMock = execSync as jest.Mock;

describe('GitRepository', () => {
  const repo = new GitRepository();

  afterEach(() => execMock.mockReset());

  it('returns a trimmed HEAD sha', () => {
    execMock.mockReturnValue('abc123\n');
    expect(repo.headSha('/repo')).toBe('abc123');
    expect(execMock.mock.calls[0][0]).toContain('rev-parse HEAD');
  });

  it('returns porcelain status output', () => {
    execMock.mockReturnValue(' M file.ts\n');
    expect(repo.status('/repo')).toBe(' M file.ts\n');
  });

  it('creates a worktree when the path does not exist', () => {
    execMock.mockReturnValue('');
    repo.addWorktree('/repo', '/nonexistent/wt', 'sdlc/run/T-01', 'base');
    expect(execMock.mock.calls[0][0]).toContain('worktree add -b');
    expect(execMock.mock.calls[0][0]).toContain('sdlc/run/T-01');
  });

  it('reuses an existing worktree directory without invoking git', () => {
    repo.addWorktree('/repo', os.tmpdir(), 'sdlc/run/T-01', 'base');
    expect(execMock).not.toHaveBeenCalled();
  });

  it('parses numstat output including binary entries', () => {
    execMock.mockReturnValue(
      '10\t2\tsrc/a.ts\n-\t-\tassets/logo.png\n3\t0\tsrc/b.ts\n'
    );
    const diff = repo.diffStat('/repo', 'base', 'head');
    expect(diff.files).toEqual([
      { path: 'src/a.ts', lines: 12 },
      { path: 'assets/logo.png', lines: 0 },
      { path: 'src/b.ts', lines: 3 }
    ]);
    expect(diff.totalLines).toBe(15);
  });

  it('wraps git failures in a typed error', () => {
    execMock.mockImplementation(() => {
      throw new Error('fatal: not a git repository');
    });
    expect(() => repo.headSha('/repo')).toThrow(
      expect.objectContaining({ code: 'GIT_FAILED' })
    );
  });

  it('stringifies non-Error throwables in the typed error', () => {
    execMock.mockImplementation(() => {
      throw 'raw failure';
    });
    expect(() => repo.status('/repo')).toThrow(
      expect.objectContaining({ code: 'GIT_FAILED', details: ['raw failure'] })
    );
  });
});
