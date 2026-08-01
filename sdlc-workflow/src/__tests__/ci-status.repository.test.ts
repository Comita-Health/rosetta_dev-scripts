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
});
