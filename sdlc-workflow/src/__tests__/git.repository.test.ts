import 'reflect-metadata';
import { EventEmitter } from 'events';

jest.mock('child_process', () => ({
  execSync: jest.fn(),
  spawn: jest.fn()
}));

import { execSync, spawn } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import { GitRepository } from '../repositories/git.repository';

const execMock = execSync as jest.Mock;
const spawnMock = spawn as jest.Mock;

/** Minimal fake child_process.ChildProcess for removeWorktreeAsync tests. */
class FakeChild extends EventEmitter {
  stderr = new EventEmitter();
  unref = jest.fn();
}

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
    expect(execMock.mock.calls[0][0]).toContain('--no-renames');
  });

  it('fetches origin and resolves refs to SHAs (P3 T-05)', () => {
    execMock.mockReturnValue('def456\n');
    repo.fetch('/repo');
    expect(execMock.mock.calls[0][0]).toContain('fetch origin');
    expect(repo.resolveSha('/repo', 'origin/main')).toBe('def456');
    expect(execMock.mock.calls[1][0]).toContain('rev-parse "origin/main"');
  });

  it('resolves a ref to the tree it points at (SPEC-PRD-0022-P1 T-01)', () => {
    // Content, not commit: this is the deploy-dedup key, so a merge commit and
    // the PR head it merged have to land on the same answer.
    execMock.mockReturnValue('tree789\n');
    expect(repo.treeSha('/repo', 'merge-commit')).toBe('tree789');
    expect(execMock.mock.calls[0][0]).toContain(
      'rev-parse "merge-commit^{tree}"'
    );
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

  it('preserves slash characters in default branch names', () => {
    execMock.mockReturnValue('refs/remotes/origin/build-env/dev\n');
    expect(repo.defaultBranch('/repo')).toBe('build-env/dev');
  });

  it('falls back to main when origin/HEAD points somewhere unexpected', () => {
    execMock.mockReturnValue('refs/heads/something-else\n');
    expect(repo.defaultBranch('/repo')).toBe('main');

    execMock.mockReturnValue('refs/remotes/origin/\n');
    expect(repo.defaultBranch('/repo')).toBe('main');
  });

  it('pushes a branch and sets its upstream', () => {
    execMock.mockReturnValue('');
    repo.push('/wt', 'sdlc/run-1/T-01');
    expect(execMock.mock.calls[0][0]).toContain(
      'push -u origin "sdlc/run-1/T-01"'
    );
  });

  it('lists tracked and unignored files, dropping blank lines', () => {
    execMock.mockReturnValue('src/a.ts\n  src/b.ts  \n\n');
    expect(repo.listFiles('/repo')).toEqual(['src/a.ts', 'src/b.ts']);
    expect(execMock.mock.calls[0][0]).toContain('--exclude-standard');
  });

  it('returns file contents at a ref, or null when absent', () => {
    execMock.mockReturnValue('# spec\n');
    expect(repo.fileAtRef('/repo', 'origin/main', 'specs/x.md')).toBe(
      '# spec\n'
    );
    expect(execMock.mock.calls[0][0]).toContain(
      'show "origin/main:specs/x.md"'
    );

    execMock.mockImplementation(() => {
      throw new Error('fatal: path does not exist');
    });
    expect(repo.fileAtRef('/repo', 'origin/main', 'missing.md')).toBeNull();
  });

  it('reports pathDiffersFromRef from git diff --quiet', () => {
    execMock.mockReturnValue('');
    expect(repo.pathDiffersFromRef('/repo', 'origin/main', 'specs/x.md')).toBe(
      false
    );

    execMock.mockImplementation(() => {
      throw new Error('exit 1');
    });
    expect(repo.pathDiffersFromRef('/repo', 'origin/main', 'specs/x.md')).toBe(
      true
    );
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

  describe('removeWorktreeAsync (fire-and-forget cleanup)', () => {
    let worktreePath: string;
    let warnSpy: jest.SpyInstance;

    beforeEach(() => {
      worktreePath = mkdtempSync(path.join(os.tmpdir(), 'sdlc-wt-'));
      spawnMock.mockReset();
      warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
      rmSync(worktreePath, { recursive: true, force: true });
      warnSpy.mockRestore();
    });

    it('does nothing when the worktree path does not exist', () => {
      repo.removeWorktreeAsync('/repo', '/definitely/not/a/real/path');
      expect(spawnMock).not.toHaveBeenCalled();
    });

    it('dispatches git worktree remove and unrefs it without waiting', () => {
      const child = new FakeChild();
      spawnMock.mockReturnValue(child);

      repo.removeWorktreeAsync('/repo', worktreePath);

      expect(spawnMock).toHaveBeenCalledWith(
        'git',
        ['-C', '/repo', 'worktree', 'remove', '--force', worktreePath],
        expect.objectContaining({ stdio: ['ignore', 'ignore', 'pipe'] })
      );
      expect(child.unref).toHaveBeenCalled();
      // A clean exit is silent — no warning for the common case.
      child.emit('close', 0);
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('warns but does not throw when the removal exits non-zero', () => {
      const child = new FakeChild();
      spawnMock.mockReturnValue(child);

      expect(() =>
        repo.removeWorktreeAsync('/repo', worktreePath)
      ).not.toThrow();
      child.stderr.emit('data', Buffer.from('fatal: worktree is locked'));
      child.emit('close', 1);

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('worktree is locked')
      );
    });

    it('warns but does not throw when spawn itself errors', () => {
      const child = new FakeChild();
      spawnMock.mockReturnValue(child);

      expect(() =>
        repo.removeWorktreeAsync('/repo', worktreePath)
      ).not.toThrow();
      child.emit('error', new Error('ENOENT'));

      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('ENOENT'));
    });
  });
});
