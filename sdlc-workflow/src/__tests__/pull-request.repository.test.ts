import 'reflect-metadata';

jest.mock('child_process', () => ({ execSync: jest.fn() }));
jest.mock('../utils/gh-auth', () => ({
  envForAddiWrite: jest.fn(() => ({ ...process.env, GH_TOKEN: 'addi-test' }))
}));

import { execSync } from 'child_process';
import { PullRequestRepository } from '../repositories/pull-request.repository';
import { envForAddiWrite } from '../utils/gh-auth';

const execMock = execSync as jest.Mock;
const addiEnv = envForAddiWrite as jest.Mock;

describe('PullRequestRepository (P3 T-02)', () => {
  const repo = new PullRequestRepository();

  afterEach(() => {
    execMock.mockReset();
    addiEnv.mockClear();
  });

  it('finds the open PR for a branch', () => {
    execMock.mockReturnValue(
      '[{"url":"https://github.com/org/repo/pull/12","number":12}]'
    );

    const ref = repo.findByBranch('/repo', 'sdlc/run-1/T-01');

    expect(ref).toEqual({
      url: 'https://github.com/org/repo/pull/12',
      number: 12
    });
    const [command, options] = execMock.mock.calls[0];
    expect(command).toContain('gh pr list --head "sdlc/run-1/T-01"');
    expect(options.cwd).toBe('/repo');
  });

  it('returns null when no PR exists for the branch', () => {
    execMock.mockReturnValue('[]');

    expect(repo.findByBranch('/repo', 'b')).toBeNull();
  });

  it('creates a PR, passing the body via stdin, and parses the URL', () => {
    execMock.mockReturnValue('https://github.com/org/repo/pull/13\n');

    const ref = repo.create('/repo', {
      branch: 'sdlc/run-1/T-01',
      title: 'sdlc(run-1): T-01 do the thing',
      body: '## Summary\nmachine-generated'
    });

    expect(ref).toEqual({
      url: 'https://github.com/org/repo/pull/13',
      number: 13
    });
    const [command, options] = execMock.mock.calls[0];
    expect(command).toContain('gh pr create --head "sdlc/run-1/T-01"');
    expect(command).toContain('--body-file -');
    expect(options.input).toBe('## Summary\nmachine-generated');
    expect(addiEnv).toHaveBeenCalledTimes(1);
    expect(options.env.GH_TOKEN).toBe('addi-test');
  });

  it('throws typed on gh failure with the tool output as detail', () => {
    execMock.mockImplementation(() => {
      throw new Error('gh: Not Found (HTTP 404)');
    });

    expect(() => repo.findByBranch('/repo', 'b')).toThrow(
      expect.objectContaining({ code: 'GH_FAILED' })
    );
    expect(() =>
      repo.create('/repo', { branch: 'b', title: 't', body: 'x' })
    ).toThrow(expect.objectContaining({ code: 'GH_FAILED' }));
  });

  it('throws typed when gh pr create returns no URL', () => {
    execMock.mockReturnValue('something unexpected');

    expect(() =>
      repo.create('/repo', { branch: 'b', title: 't', body: 'x' })
    ).toThrow(expect.objectContaining({ code: 'GH_FAILED' }));
  });

  it('comments on a PR via body-file stdin', () => {
    execMock.mockReturnValue('');

    repo.comment('/repo', 12, '## reviewer\npass');

    const [command, options] = execMock.mock.calls[0];
    expect(command).toContain('gh pr comment 12 --body-file -');
    expect(options.input).toBe('## reviewer\npass');
  });

  describe('merge (P3 T-04)', () => {
    it('merges the PR with a merge commit and returns the merge SHA', () => {
      execMock
        .mockReturnValueOnce('') // gh pr merge
        .mockReturnValueOnce('abc123def4567890abc123def4567890abc123de\n');

      const sha = repo.merge('/repo', 14);

      expect(sha).toBe('abc123def4567890abc123def4567890abc123de');
      expect(execMock.mock.calls[0][0]).toContain('gh pr merge 14 --merge');
      expect(execMock.mock.calls[1][0]).toContain('gh pr view 14');
    });

    it('throws typed when the merge succeeds but the SHA cannot be resolved', () => {
      execMock.mockReturnValueOnce('').mockReturnValueOnce('null\n');

      expect(() => repo.merge('/repo', 14)).toThrow(
        expect.objectContaining({ code: 'GH_FAILED' })
      );
    });

    it('throws typed when gh pr merge fails', () => {
      execMock.mockImplementation(() => {
        throw new Error('gh: merge conflict');
      });

      expect(() => repo.merge('/repo', 14)).toThrow(
        expect.objectContaining({ code: 'GH_FAILED' })
      );
    });
  });

  describe('mergeCommitOid (merge reconciliation)', () => {
    it('returns the merge commit OID when GitHub reports the PR merged', () => {
      execMock.mockReturnValue('abc123def4567890abc123def4567890abc123de\n');

      expect(repo.mergeCommitOid('/repo', 14)).toBe(
        'abc123def4567890abc123def4567890abc123de'
      );
      expect(execMock.mock.calls[0][0]).toContain(
        'gh pr view 14 --json mergeCommit'
      );
      expect(execMock.mock.calls[0][0]).toContain('.mergeCommit.oid // empty');
    });

    it('returns null when the PR has no merge commit (genuinely unmerged)', () => {
      execMock.mockReturnValue('\n');

      expect(repo.mergeCommitOid('/repo', 14)).toBeNull();
    });

    it('returns null for a non-SHA jq payload', () => {
      execMock.mockReturnValue('null\n');

      expect(repo.mergeCommitOid('/repo', 14)).toBeNull();
    });
  });

  // SPEC-PRD-0023-P1 T-02 / T-04: closeout branches outlive the PR on them, so
  // both the generator and the completion check need state, not just open-ness.
  describe('latestForBranch', () => {
    it('reports the PR with its state, including merged and closed', () => {
      for (const state of ['OPEN', 'MERGED', 'CLOSED'] as const) {
        execMock.mockReturnValueOnce(
          `[{"url":"https://github.com/o/r/pull/9","number":9,"state":"${state}"}]`
        );

        expect(repo.latestForBranch('/repo', 'sdlc/closeout/SPEC-X')).toEqual({
          url: 'https://github.com/o/r/pull/9',
          number: 9,
          state
        });
      }
    });

    it('queries every state so a merged closeout is not mistaken for a missing one', () => {
      execMock.mockReturnValue('[]');

      repo.latestForBranch('/repo', 'sdlc/closeout/SPEC-X');

      const [command, options] = execMock.mock.calls[0];
      expect(command).toContain('gh pr list --head "sdlc/closeout/SPEC-X"');
      expect(command).toContain('--state all');
      expect(command).toContain('--limit 1');
      expect(options.cwd).toBe('/repo');
    });

    it('returns null when the branch never had a PR', () => {
      execMock.mockReturnValue('[]');

      expect(repo.latestForBranch('/repo', 'b')).toBeNull();
    });

    it('throws typed on unparseable gh output rather than reporting no PR', () => {
      execMock.mockReturnValue('gh: rate limit exceeded');

      expect(() => repo.latestForBranch('/repo', 'b')).toThrow(
        expect.objectContaining({ code: 'GH_FAILED' })
      );
    });
  });

  describe('updateBody', () => {
    it('refreshes an existing PR body via stdin', () => {
      execMock.mockReturnValue('');

      repo.updateBody('/repo', 9, '## Summary\nderived from run-1');

      const [command, options] = execMock.mock.calls[0];
      expect(command).toContain('gh pr edit 9 --body-file -');
      expect(options.input).toBe('## Summary\nderived from run-1');
    });

    it('throws typed when gh cannot edit the PR', () => {
      execMock.mockImplementation(() => {
        throw new Error('gh: pull request is closed');
      });

      expect(() => repo.updateBody('/repo', 9, 'x')).toThrow(
        expect.objectContaining({ code: 'GH_FAILED' })
      );
    });
  });
});
