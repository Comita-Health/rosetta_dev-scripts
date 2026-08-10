import 'reflect-metadata';
import {
  DeployObservationRepository,
  IDeployObservationRepository
} from '../repositories/deploy-observation.repository';
import { runGh } from '../utils/gh-cli';

jest.mock('../utils/gh-cli', () => ({
  runGh: jest.fn()
}));

const runGhMock = runGh as jest.MockedFunction<typeof runGh>;

describe('DeployObservationRepository', () => {
  let repo: IDeployObservationRepository;

  beforeEach(() => {
    runGhMock.mockReset();
    repo = new DeployObservationRepository();
  });

  it('reports absent when workflow or sha is empty without calling gh', () => {
    expect(repo.observe('/wt', 'abc', '')).toEqual({ state: 'absent' });
    expect(repo.observe('/wt', '', 'deploy.yml')).toEqual({ state: 'absent' });
    expect(runGhMock).not.toHaveBeenCalled();
  });

  it('reports in-flight when Actions has a queued or running deploy for the SHA', () => {
    runGhMock.mockReturnValue(
      JSON.stringify([
        {
          status: 'in_progress',
          conclusion: null,
          url: 'https://github.com/org/repo/actions/runs/9',
          event: 'push'
        }
      ])
    );

    expect(repo.observe('/wt', 'abc123', 'deploy-organization.yml')).toEqual({
      state: 'in-flight',
      workflowRef: 'https://github.com/org/repo/actions/runs/9'
    });
    expect(runGhMock.mock.calls[0][1]).toContain('--commit');
    expect(runGhMock.mock.calls[0][1]).toContain('deploy-organization.yml');
  });

  it('prefers in-flight over a completed success for the same SHA', () => {
    runGhMock.mockReturnValue(
      JSON.stringify([
        {
          status: 'completed',
          conclusion: 'success',
          url: 'https://github.com/org/repo/actions/runs/1',
          event: 'push'
        },
        {
          status: 'queued',
          conclusion: null,
          url: 'https://github.com/org/repo/actions/runs/2',
          event: 'workflow_dispatch'
        }
      ])
    );

    expect(repo.observe('/wt', 'abc123', 'deploy.yml').state).toBe('in-flight');
  });

  it('reports succeeded when the latest terminal run for the SHA is green', () => {
    runGhMock.mockReturnValue(
      JSON.stringify([
        {
          status: 'completed',
          conclusion: 'success',
          url: 'https://github.com/org/repo/actions/runs/7',
          event: 'push'
        }
      ])
    );

    expect(repo.observe('/wt', 'abc123', 'deploy.yml')).toEqual({
      state: 'succeeded',
      workflowRef: 'https://github.com/org/repo/actions/runs/7'
    });
  });

  it('reports absent on gh failure or malformed JSON (fail-open)', () => {
    runGhMock.mockImplementation(() => {
      throw new Error('gh unavailable');
    });
    expect(repo.observe('/wt', 'abc123', 'deploy.yml')).toEqual({
      state: 'absent'
    });

    runGhMock.mockReturnValue('not-json');
    expect(repo.observe('/wt', 'abc123', 'deploy.yml')).toEqual({
      state: 'absent'
    });
  });

  it('reports absent when only failed runs exist for the SHA', () => {
    runGhMock.mockReturnValue(
      JSON.stringify([
        {
          status: 'completed',
          conclusion: 'failure',
          url: 'https://github.com/org/repo/actions/runs/3',
          event: 'push'
        }
      ])
    );
    expect(repo.observe('/wt', 'abc123', 'deploy.yml')).toEqual({
      state: 'absent'
    });
  });
});
