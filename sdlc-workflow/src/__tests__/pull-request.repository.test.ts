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
      expect(execMock.mock.calls[1][0]).toContain(
        'gh pr merge 14 --squash --delete-branch'
      );
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
  });
});
