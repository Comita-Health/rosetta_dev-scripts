import 'reflect-metadata';

jest.mock('child_process', () => ({ execSync: jest.fn() }));

import { execSync } from 'child_process';
import { IssueRepository } from '../repositories/issue.repository';

const execMock = execSync as jest.Mock;

describe('IssueRepository (fail-loud T-04)', () => {
  const repo = new IssueRepository();

  afterEach(() => execMock.mockReset());

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

  it('creates an issue with assignee and body via stdin', () => {
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
    const [command, options] = execMock.mock.calls[0];
    expect(command).toContain('gh issue create');
    expect(command).toContain('--assignee "russwatson"');
    expect(command).toContain('--body-file -');
    expect(options.input).toBe('needs human');
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
