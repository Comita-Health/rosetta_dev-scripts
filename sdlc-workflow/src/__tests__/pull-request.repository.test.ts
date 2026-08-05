import 'reflect-metadata';

jest.mock('child_process', () => ({ execSync: jest.fn() }));

import { execSync } from 'child_process';
import { PullRequestRepository } from '../repositories/pull-request.repository';

const execMock = execSync as jest.Mock;

describe('PullRequestRepository (P3 T-02)', () => {
  const repo = new PullRequestRepository();

  // merge-async polls on a 5s timer; fake timers keep the suite instant.
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.useRealTimers();
    execMock.mockReset();
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

  it('throws typed when gh pr list returns unparseable JSON', () => {
    execMock.mockReturnValue('gh: unexpected banner text');

    expect(() => repo.findByBranch('/repo', 'b')).toThrow(
      expect.objectContaining({ code: 'GH_FAILED' })
    );
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
    it('squashes an unstacked PR and returns the merge SHA', async () => {
      execMock
        .mockReturnValueOnce('') // gh api .stack -> empty
        .mockReturnValueOnce('') // gh pr merge
        .mockReturnValueOnce('abc123def4567890abc123def4567890abc123de\n');

      const sha = await repo.merge('/repo', 14);

      expect(sha).toBe('abc123def4567890abc123def4567890abc123de');
      expect(execMock.mock.calls[1][0]).toContain('gh pr merge 14 --squash');
      // The engine merges branches held in its own worktrees, where gh's
      // local delete always fails after the merge has landed.
      expect(execMock.mock.calls[1][0]).not.toContain('--delete-branch');
      expect(execMock.mock.calls[2][0]).toContain('gh pr view 14');
    });

    it('merges a stacked PR via merge-async with merge commits', async () => {
      execMock
        .mockReturnValueOnce('{"base":"f/parent"}\n') // .stack present
        .mockReturnValueOnce('{"status":"merged"}')
        .mockReturnValueOnce('abc123def4567890abc123def4567890abc123de\n');

      const sha = await repo.merge('/repo', 14);

      expect(sha).toBe('abc123def4567890abc123def4567890abc123de');
      expect(execMock.mock.calls[1][0]).toContain('merge-async');
      expect(execMock.mock.calls[1][0]).toContain('merge_method=merge');
    });

    it('polls merge-async until the stack lands', async () => {
      execMock
        .mockReturnValueOnce('{"base":"f/parent"}\n')
        .mockReturnValueOnce('{"status":"pending","details":{"uuid":"u-1"}}')
        .mockReturnValueOnce('{"status":"merged"}')
        .mockReturnValueOnce('abc123def4567890abc123def4567890abc123de\n');

      const merged = repo.merge('/repo', 14);
      await jest.advanceTimersByTimeAsync(5_000);

      expect(await merged).toBe('abc123def4567890abc123def4567890abc123de');
      expect(execMock.mock.calls[2][0]).toContain('merge-async/u-1');
    });

    it('throws typed when merge-async reports failure', async () => {
      execMock
        .mockReturnValueOnce('{"base":"f/parent"}\n')
        .mockReturnValueOnce('{"status":"pending","details":{"uuid":"u-1"}}')
        .mockReturnValueOnce(
          '{"status":"failed","details":{"message":"conflict"}}'
        );

      // Attach the rejection handler before advancing so the failure is
      // never an unhandled rejection.
      const assertion = expect(repo.merge('/repo', 14)).rejects.toThrow(
        expect.objectContaining({ code: 'GH_FAILED' })
      );
      await jest.advanceTimersByTimeAsync(5_000);
      await assertion;
    });

    it('throws typed when merge-async neither merges nor enqueues', async () => {
      execMock
        .mockReturnValueOnce('{"base":"f/parent"}\n')
        .mockReturnValueOnce('{"status":"rejected"}');

      await expect(repo.merge('/repo', 14)).rejects.toThrow(
        expect.objectContaining({ code: 'GH_FAILED' })
      );
    });

    it('throws typed when merge-async reports pending without a uuid', async () => {
      execMock
        .mockReturnValueOnce('{"base":"f/parent"}\n')
        .mockReturnValueOnce('{"status":"pending","details":{}}');

      await expect(repo.merge('/repo', 14)).rejects.toThrow(
        expect.objectContaining({ code: 'GH_FAILED' })
      );
    });

    it('gives up on merge-async rather than polling forever', async () => {
      execMock
        .mockReturnValueOnce('{"base":"f/parent"}\n')
        .mockReturnValueOnce('{"status":"pending","details":{"uuid":"u-1"}}')
        .mockReturnValue('{"status":"pending"}');

      const assertion = expect(repo.merge('/repo', 14)).rejects.toThrow(
        expect.objectContaining({ code: 'GH_FAILED' })
      );
      // Past the 10-minute ceiling; the loop must exit on the deadline check.
      await jest.advanceTimersByTimeAsync(11 * 60_000);
      await assertion;
    });

    it('treats a merge-async error status as failure', async () => {
      execMock
        .mockReturnValueOnce('{"base":"f/parent"}\n')
        .mockReturnValueOnce('{"status":"pending","details":{"uuid":"u-1"}}')
        .mockReturnValueOnce('{"status":"error"}');

      const assertion = expect(repo.merge('/repo', 14)).rejects.toThrow(
        expect.objectContaining({ code: 'GH_FAILED' })
      );
      await jest.advanceTimersByTimeAsync(5_000);
      await assertion;
    });

    it('skips polling when merge-async lands the stack immediately', async () => {
      execMock
        .mockReturnValueOnce('{"base":"f/parent"}\n')
        .mockReturnValueOnce('{"status":"merged"}')
        .mockReturnValueOnce('abc123def4567890abc123def4567890abc123de\n');

      await expect(repo.merge('/repo', 14)).resolves.toBe(
        'abc123def4567890abc123def4567890abc123de'
      );
      expect(execMock).toHaveBeenCalledTimes(3);
    });

    it('treats a literal null stack field as unstacked', async () => {
      execMock
        .mockReturnValueOnce('null\n')
        .mockReturnValueOnce('')
        .mockReturnValueOnce('abc123def4567890abc123def4567890abc123de\n');

      await repo.merge('/repo', 14);

      expect(execMock.mock.calls[1][0]).toContain('--squash');
    });

    it('throws typed when the merge succeeds but the SHA cannot be resolved', async () => {
      execMock
        .mockReturnValueOnce('')
        .mockReturnValueOnce('')
        .mockReturnValueOnce('null\n');

      await expect(repo.merge('/repo', 14)).rejects.toThrow(
        expect.objectContaining({ code: 'GH_FAILED' })
      );
    });

    it('throws typed when gh pr merge fails', async () => {
      execMock.mockImplementation(() => {
        throw new Error('gh: merge conflict');
      });

      await expect(repo.merge('/repo', 14)).rejects.toThrow(
        expect.objectContaining({ code: 'GH_FAILED' })
      );
    });

    it('succeeds when gh exits non-zero but the merge actually landed', async () => {
      execMock
        .mockReturnValueOnce('') // .stack -> unstacked
        .mockImplementationOnce(() => {
          throw new Error('failed to delete local branch: used by worktree');
        })
        .mockReturnValueOnce('MERGED\n') // state probe
        .mockReturnValueOnce('abc123def4567890abc123def4567890abc123de\n');

      await expect(repo.merge('/repo', 14)).resolves.toBe(
        'abc123def4567890abc123def4567890abc123de'
      );
    });

    it('still throws when gh fails and the PR is not merged', async () => {
      execMock
        .mockReturnValueOnce('')
        .mockImplementationOnce(() => {
          throw new Error('gh: merge conflict');
        })
        .mockReturnValueOnce('OPEN\n');

      await expect(repo.merge('/repo', 14)).rejects.toThrow(
        expect.objectContaining({ code: 'GH_FAILED' })
      );
    });

    it('reports failure when even the merged-state probe fails', async () => {
      execMock
        .mockReturnValueOnce('')
        .mockImplementationOnce(() => {
          throw new Error('gh: merge conflict');
        })
        .mockImplementationOnce(() => {
          throw new Error('gh: network down');
        });

      await expect(repo.merge('/repo', 14)).rejects.toThrow(
        expect.objectContaining({ code: 'GH_FAILED' })
      );
    });

    it('reconciles a stacked merge that errored after landing', async () => {
      execMock
        .mockReturnValueOnce('{"base":"f/parent"}\n')
        .mockReturnValueOnce('{"status":"rejected"}') // mergeStack throws
        .mockReturnValueOnce('MERGED\n')
        .mockReturnValueOnce('abc123def4567890abc123def4567890abc123de\n');

      await expect(repo.merge('/repo', 14)).resolves.toBe(
        'abc123def4567890abc123def4567890abc123de'
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
