jest.mock('../utils/gh-cli', () => ({ runGh: jest.fn() }));
jest.mock('../utils/gh-repo', () => ({
  originSlug: jest.fn(() => 'org/repo')
}));

import { CiStatusRepository } from '../repositories/ci-status.repository';
import { runGh } from '../utils/gh-cli';

const ghMock = runGh as jest.Mock;

/** [command, options] for the nth gh call (arg 0 is the repo path). */
const callArgs = (
  index: number
): [string, { stdin?: string; requireAddi?: boolean } | undefined] => [
  ghMock.mock.calls[index][1],
  ghMock.mock.calls[index][2]
];

describe('CiStatusRepository', () => {
  const repo = new CiStatusRepository();

  beforeEach(() => ghMock.mockReset());

  it('queries check runs for the SHA via gh in the repo directory', () => {
    ghMock.mockReturnValue(
      JSON.stringify([
        { name: 'ci', status: 'completed', conclusion: 'success' },
        { name: 'dco', status: 'completed', conclusion: 'neutral' },
        { name: 'lint', status: 'completed', conclusion: 'skipped' }
      ])
    );

    const summary = repo.checkRuns('/repo', 'abc123');

    expect(ghMock.mock.calls[0][0]).toBe('/repo');
    expect(callArgs(0)[0]).toContain(
      'repos/org/repo/commits/abc123/check-runs'
    );
    expect(summary).toEqual({ total: 3, failed: [], pending: [] });
  });

  it('reports failed and pending runs by name', () => {
    ghMock.mockReturnValue(
      JSON.stringify([
        { name: 'ci', status: 'completed', conclusion: 'failure' },
        { name: 'e2e', status: 'in_progress', conclusion: null }
      ])
    );

    expect(repo.checkRuns('/repo', 'abc')).toEqual({
      total: 2,
      failed: ['ci'],
      pending: ['e2e']
    });
  });

  it('returns null when gh fails (commit not on remote)', () => {
    ghMock.mockImplementation(() => {
      throw new Error('HTTP 422: No commit found');
    });

    expect(repo.checkRuns('/repo', 'abc')).toBeNull();
  });

  it('returns null on unparseable gh output', () => {
    ghMock.mockReturnValue('not json');

    expect(repo.checkRuns('/repo', 'abc')).toBeNull();
  });

  it('fetches failed-step logs for the failing runs at a SHA (P3 T-03)', () => {
    ghMock
      .mockReturnValueOnce('101\n102\n')
      .mockReturnValueOnce('run 101: TS2304 error\n')
      .mockReturnValueOnce('run 102: jest failed\n');

    const logs = repo.failedLogs('/repo', 'abc123');

    expect(callArgs(0)[0]).toContain(
      'gh run list --commit abc123 --status failure'
    );
    expect(callArgs(1)[0]).toContain('gh run view 101 --log-failed');
    expect(callArgs(2)[0]).toContain('gh run view 102 --log-failed');
    expect(logs).toContain('TS2304 error');
    expect(logs).toContain('jest failed');
  });

  it('creates a commit status via gh api --input JSON', () => {
    ghMock.mockReturnValue('{}');

    repo.createStatus('/repo', 'abc123', {
      state: 'success',
      context: 'sdlc/reviewer',
      description: 'T-01: pass',
      targetUrl: 'https://github.com/org/repo/pull/7'
    });

    const [command, options] = callArgs(0);
    expect(command).toContain('repos/org/repo/statuses/abc123');
    expect(command).toContain('--input -');
    expect(JSON.parse(options?.stdin ?? '{}')).toEqual({
      state: 'success',
      context: 'sdlc/reviewer',
      description: 'T-01: pass',
      target_url: 'https://github.com/org/repo/pull/7'
    });
  });

  // The reviewer gate shows up on the PR as a status check, so it has to be
  // posted by the App rather than whoever happens to be authenticated.
  it('posts the commit status as Addi', () => {
    ghMock.mockReturnValue('{}');

    repo.createStatus('/repo', 'abc', {
      state: 'success',
      context: 'sdlc/reviewer'
    });

    expect(callArgs(0)[1]?.requireAddi).toBe(true);
  });

  it('omits empty optional status fields and wraps gh failures', () => {
    ghMock.mockReturnValue('{}');
    repo.createStatus('/repo', 'sha', {
      state: 'pending',
      context: 'sdlc/reviewer',
      description: '',
      targetUrl: ''
    });
    expect(JSON.parse(callArgs(0)[1]?.stdin ?? '{}')).toEqual({
      state: 'pending',
      context: 'sdlc/reviewer'
    });

    ghMock.mockImplementation(() => {
      throw 'boom';
    });
    expect(() =>
      repo.createStatus('/repo', 'sha', {
        state: 'failure',
        context: 'sdlc/reviewer'
      })
    ).toThrow(expect.objectContaining({ code: 'GH_FAILED' }));
  });

  it('failedLogs is best effort: empty string on failure, partial on one bad run', () => {
    ghMock.mockImplementation(() => {
      throw new Error('gh down');
    });
    expect(repo.failedLogs('/repo', 'abc')).toBe('');

    ghMock.mockReset();
    ghMock
      .mockReturnValueOnce('201\n202\n')
      .mockImplementationOnce(() => {
        throw new Error('log expired');
      })
      .mockReturnValueOnce('run 202: useful log\n');
    expect(repo.failedLogs('/repo', 'abc')).toContain('useful log');
  });
});
