jest.mock('child_process', () => ({ execSync: jest.fn() }));

import { execSync } from 'child_process';
import { CiStatusRepository } from '../repositories/ci-status.repository';

const execMock = execSync as jest.Mock;

describe('CiStatusRepository', () => {
  const repo = new CiStatusRepository();

  beforeEach(() => execMock.mockReset());

  it('queries check runs for the SHA via gh in the repo directory', () => {
    execMock.mockReturnValue(
      JSON.stringify([
        { name: 'ci', status: 'completed', conclusion: 'success' },
        { name: 'dco', status: 'completed', conclusion: 'neutral' },
        { name: 'lint', status: 'completed', conclusion: 'skipped' }
      ])
    );

    const summary = repo.checkRuns('/repo', 'abc123');

    expect(execMock.mock.calls[0][0]).toContain(
      'repos/{owner}/{repo}/commits/abc123/check-runs'
    );
    expect(execMock.mock.calls[0][1]).toEqual(
      expect.objectContaining({ cwd: '/repo' })
    );
    expect(summary).toEqual({ total: 3, failed: [], pending: [] });
  });

  it('reports failed and pending runs by name', () => {
    execMock.mockReturnValue(
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
    execMock.mockImplementation(() => {
      throw new Error('HTTP 422: No commit found');
    });

    expect(repo.checkRuns('/repo', 'abc')).toBeNull();
  });

  it('returns null on unparseable gh output', () => {
    execMock.mockReturnValue('not json');

    expect(repo.checkRuns('/repo', 'abc')).toBeNull();
  });

  it('fetches failed-step logs for the failing runs at a SHA (P3 T-03)', () => {
    execMock
      .mockReturnValueOnce('101\n102\n')
      .mockReturnValueOnce('run 101: TS2304 error\n')
      .mockReturnValueOnce('run 102: jest failed\n');

    const logs = repo.failedLogs('/repo', 'abc123');

    expect(execMock.mock.calls[0][0]).toContain(
      'gh run list --commit abc123 --status failure'
    );
    expect(execMock.mock.calls[1][0]).toContain('gh run view 101 --log-failed');
    expect(execMock.mock.calls[2][0]).toContain('gh run view 102 --log-failed');
    expect(logs).toContain('TS2304 error');
    expect(logs).toContain('jest failed');
  });

  it('creates a commit status via gh api --input JSON', () => {
    execMock.mockReturnValue('{}');

    repo.createStatus('/repo', 'abc123', {
      state: 'success',
      context: 'sdlc/reviewer',
      description: 'T-01: pass',
      targetUrl: 'https://github.com/org/repo/pull/7'
    });

    const [command, options] = execMock.mock.calls[0];
    expect(command).toContain('repos/{owner}/{repo}/statuses/abc123');
    expect(command).toContain('--input -');
    expect(JSON.parse(options.input)).toEqual({
      state: 'success',
      context: 'sdlc/reviewer',
      description: 'T-01: pass',
      target_url: 'https://github.com/org/repo/pull/7'
    });
  });

  it('failedLogs is best effort: empty string on failure, partial on one bad run', () => {
    execMock.mockImplementation(() => {
      throw new Error('gh down');
    });
    expect(repo.failedLogs('/repo', 'abc')).toBe('');

    execMock.mockReset();
    execMock
      .mockReturnValueOnce('201\n202\n')
      .mockImplementationOnce(() => {
        throw new Error('log expired');
      })
      .mockReturnValueOnce('run 202: useful log\n');
    expect(repo.failedLogs('/repo', 'abc')).toContain('useful log');
  });
});
