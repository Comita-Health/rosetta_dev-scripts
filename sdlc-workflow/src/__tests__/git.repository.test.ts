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

  it('returns the full unified diff text', () => {
    execMock.mockReturnValue('diff --git a/x b/x\n+line\n');
    expect(repo.diffText('/repo', 'base', 'head')).toContain('+line');
    expect(execMock.mock.calls[0][0]).toContain('diff "base".."head"');
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

  it('fetches origin and resolves refs to SHAs (P3 T-05)', () => {
    execMock.mockReturnValue('def456\n');
    repo.fetch('/repo');
    expect(execMock.mock.calls[0][0]).toContain('fetch origin');
    expect(repo.resolveSha('/repo', 'origin/main')).toBe('def456');
    expect(execMock.mock.calls[1][0]).toContain('rev-parse "origin/main"');
  });

  it('reads the default branch from origin/HEAD, falling back to main', () => {
    execMock.mockReturnValue('refs/remotes/origin/trunk\n');
    expect(repo.defaultBranch('/repo')).toBe('trunk');

    execMock.mockImplementation(() => {
      throw new Error(
        'fatal: ref refs/remotes/origin/HEAD is not a symbolic ref'
      );
    });
    expect(repo.defaultBranch('/repo')).toBe('main');
  });

  it('keeps slashes in the default branch name', () => {
    execMock.mockReturnValue('refs/remotes/origin/build-env/dev\n');
    expect(repo.defaultBranch('/repo')).toBe('build-env/dev');
  });

  it('reverts a merge commit first-parent with sign-off (P3 T-05)', () => {
    execMock.mockReturnValue('');
    repo.revertMerge('/wt', 'merge-sha');
    expect(execMock.mock.calls[0][0]).toContain(
      'revert --no-edit --signoff -m 1 "merge-sha"'
    );
  });

  it('stages all changes and commits with --no-verify --signoff (#41)', () => {
    execMock.mockReturnValue('');
    repo.stageAll('/wt');
    expect(execMock.mock.calls[0][0]).toContain('add -A');
    repo.commit('/wt', 'feat(T-01): implement thing', {
      noVerify: true,
      signOff: true
    });
    expect(execMock.mock.calls[1][0]).toContain('--no-verify');
    expect(execMock.mock.calls[1][0]).toContain('--signoff');
    expect(execMock.mock.calls[1][0]).toContain('feat(T-01): implement thing');
  });

  it('commits without flags when options are omitted', () => {
    execMock.mockReturnValue('');
    repo.commit('/wt', 'chore: plain');
    expect(execMock.mock.calls[0][0]).toContain('commit -m "chore: plain"');
    expect(execMock.mock.calls[0][0]).not.toContain('--no-verify');
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
