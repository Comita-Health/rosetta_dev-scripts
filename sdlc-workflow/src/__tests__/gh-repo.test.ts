jest.mock('child_process', () => ({ execSync: jest.fn() }));

import { execSync } from 'child_process';
import { clearOriginSlugCache, originSlug } from '../utils/gh-repo';

const execMock = execSync as jest.Mock;

describe('originSlug', () => {
  beforeEach(() => {
    execMock.mockReset();
    clearOriginSlugCache();
  });

  it('reads the origin remote from the given checkout', () => {
    execMock.mockReturnValue(
      'git@github.com:Comita-Health/rosetta_dev-scripts.git\n'
    );

    expect(originSlug('/repo')).toBe('Comita-Health/rosetta_dev-scripts');

    const [command, options] = execMock.mock.calls[0];
    expect(command).toBe('git remote get-url origin');
    expect(options.cwd).toBe('/repo');
  });

  it.each([
    ['git@github.com:org/repo.git', 'org/repo'],
    ['git@github.com:org/repo', 'org/repo'],
    ['https://github.com/org/repo.git', 'org/repo'],
    ['https://github.com/org/repo', 'org/repo']
  ])('parses %s', (url, expected) => {
    execMock.mockReturnValue(`${url}\n`);
    expect(originSlug('/repo')).toBe(expected);
  });

  // The regression this exists for: the engine pushes task branches to
  // `origin`, so a fork whose `gh` context resolves to the upstream parent
  // opens PRs against a repository the branch was never pushed to.
  it('resolves the fork itself, never its upstream parent', () => {
    execMock.mockReturnValue(
      'git@github.com:Comita-Health/rosetta_dev-scripts.git\n'
    );

    expect(originSlug('/fork')).not.toContain('Rosetta-Foundation');
  });

  it('reads the remote once per checkout', () => {
    execMock.mockReturnValue('git@github.com:org/repo.git\n');

    originSlug('/repo');
    originSlug('/repo');

    expect(execMock).toHaveBeenCalledTimes(1);
  });

  it('resolves each checkout independently', () => {
    execMock
      .mockReturnValueOnce('git@github.com:org/one.git\n')
      .mockReturnValueOnce('git@github.com:org/two.git\n');

    expect(originSlug('/one')).toBe('org/one');
    expect(originSlug('/two')).toBe('org/two');
  });

  it('fails loud when origin is absent', () => {
    execMock.mockImplementation(() => {
      throw new Error('fatal: No such remote');
    });

    expect(() => originSlug('/repo')).toThrow(
      expect.objectContaining({ code: 'GH_FAILED' })
    );
  });

  it('fails loud rather than letting gh pick a repository', () => {
    execMock.mockReturnValue('/srv/git/bare.git\n');

    expect(() => originSlug('/repo')).toThrow(
      expect.objectContaining({ code: 'GH_FAILED' })
    );
  });
});
