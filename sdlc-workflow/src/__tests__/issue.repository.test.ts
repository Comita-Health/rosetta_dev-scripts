import 'reflect-metadata';

jest.mock('child_process', () => ({ execSync: jest.fn() }));
jest.mock('../utils/gh-auth', () => ({
  envForAddiWrite: jest.fn(() => ({ ...process.env, GH_TOKEN: 'addi-test' }))
}));
jest.mock('../utils/gh-repo', () => ({
  originSlug: jest.fn(() => 'org/repo')
}));

import { execSync } from 'child_process';
import { IssueRepository } from '../repositories/issue.repository';
import { envForAddiWrite } from '../utils/gh-auth';

const execMock = execSync as jest.Mock;
const addiEnv = envForAddiWrite as jest.Mock;

describe('IssueRepository (fail-loud T-04)', () => {
  const repo = new IssueRepository();

  afterEach(() => {
    execMock.mockReset();
    addiEnv.mockClear();
  });

  it('finds an open issue by exact title', () => {
    execMock.mockReturnValue(
      JSON.stringify([
        {
          url: 'https://github.com/org/repo/issues/9',
          number: 9,
          title: 'ACTION REQUIRED: SDLC run-1 T-01 — merge-blocked'
        },
        {
          url: 'https://github.com/org/repo/issues/8',
          number: 8,
          title: 'other'
        }
      ])
    );

    const ref = repo.findByTitle(
      '/repo',
      'ACTION REQUIRED: SDLC run-1 T-01 — merge-blocked'
    );

    expect(ref).toEqual({
      url: 'https://github.com/org/repo/issues/9',
      number: 9
    });
    const [command, options] = execMock.mock.calls[0];
    expect(command).toContain('gh issue list');
    expect(command).toContain('in:title');
    expect(options.cwd).toBe('/repo');
    // Reads take the App identity too. Ambient auth in a detached run is the
    // operator's launch-time token, which expires while the run continues -
    // a lookup on that token 401s and the caller reads the failure as "no
    // such issue", so escalation posts a duplicate.
    expect(addiEnv).toHaveBeenCalled();
  });

  it('returns null when no exact title match exists', () => {
    execMock.mockReturnValue(
      JSON.stringify([
        {
          url: 'https://github.com/org/repo/issues/1',
          number: 1,
          title: 'nearby but not exact'
        }
      ])
    );

    expect(repo.findByTitle('/repo', 'exact')).toBeNull();
  });

  it('creates an issue as Addi with assignee and body via stdin', () => {
    execMock.mockReturnValue('https://github.com/org/repo/issues/11\n');

    const ref = repo.create('/repo', {
      title: 'ACTION REQUIRED: SDLC run-1 T-01 — envelope-breach',
      body: 'needs human',
      assignee: 'russwatson'
    });

    expect(ref).toEqual({
      url: 'https://github.com/org/repo/issues/11',
      number: 11
    });
    expect(addiEnv).toHaveBeenCalledTimes(1);
    const [command, options] = execMock.mock.calls[0];
    expect(command).toContain('gh issue create');
    expect(command).toContain('--assignee "russwatson"');
    expect(command).toContain('--body-file -');
    expect(options.input).toBe('needs human');
    expect(options.env.GH_TOKEN).toBe('addi-test');
  });

  it('omits --assignee when no operator is provided', () => {
    execMock.mockReturnValue('https://github.com/org/repo/issues/12\n');

    repo.create('/repo', {
      title: 't',
      body: 'b'
    });

    const [command] = execMock.mock.calls[0];
    expect(command).not.toContain('--assignee');
  });

  it('throws typed on gh failure', () => {
    execMock.mockImplementation(() => {
      throw new Error('gh: HTTP 403');
    });

    expect(() =>
      repo.create('/repo', { title: 't', body: 'b', assignee: 'x' })
    ).toThrow(expect.objectContaining({ code: 'GH_FAILED' }));
  });
});
