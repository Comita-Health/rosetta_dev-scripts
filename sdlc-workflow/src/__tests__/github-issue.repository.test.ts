import 'reflect-metadata';

jest.mock('child_process', () => ({ execSync: jest.fn() }));

import { execSync } from 'child_process';
import {
  GitHubIssueRepository,
  issueMarker
} from '../repositories/github-issue.repository';

const execMock = execSync as jest.Mock;

const listing = (
  ...issues: { number: number; state: string; body?: string }[]
): string =>
  JSON.stringify(
    issues.map(i => ({
      number: i.number,
      url: `https://github.com/o/r/issues/${i.number}`,
      state: i.state,
      body: i.body
    }))
  );

describe('GitHubIssueRepository (needs-human surface)', () => {
  const repo = new GitHubIssueRepository();

  afterEach(() => execMock.mockReset());

  describe('upsert', () => {
    it('creates a labelled issue and appends the idempotency marker', () => {
      execMock
        .mockReturnValueOnce('[]') // findByMarker(open) -> none
        .mockReturnValueOnce('') // ensureLabel needs-human
        .mockReturnValueOnce('') // ensureLabel sdlc-run:run-1
        .mockReturnValueOnce('https://github.com/o/r/issues/42\n');

      const ref = repo.upsert({
        repoPath: '/repo',
        key: 'run-1/T-01/no-commit',
        title: 'ACTION REQUIRED: T-01',
        body: 'the agent committed nothing',
        labels: ['needs-human', 'sdlc-run:run-1']
      });

      expect(ref).toEqual({
        number: 42,
        url: 'https://github.com/o/r/issues/42',
        state: 'OPEN'
      });

      const [command, options] = execMock.mock.calls[3];
      expect(command).toContain('gh issue create');
      expect(command).toContain('--label "needs-human"');
      expect(command).toContain('--label "sdlc-run:run-1"');
      expect(command).toContain('--body-file -');
      // The marker, not the title, is what makes a re-run idempotent.
      expect(options.input).toContain(issueMarker('run-1/T-01/no-commit'));
      expect(options.input).toContain('the agent committed nothing');
    });

    it('refreshes the existing open issue instead of opening a duplicate', () => {
      const key = 'run-1/T-01/merge-blocked';
      execMock
        .mockReturnValueOnce(
          listing({
            number: 9,
            state: 'OPEN',
            body: `old\n${issueMarker(key)}`
          })
        )
        .mockReturnValueOnce('');

      const ref = repo.upsert({
        repoPath: '/repo',
        key,
        title: 'ACTION REQUIRED',
        body: 'fresh reasons',
        labels: ['needs-human']
      });

      expect(ref.number).toBe(9);
      expect(execMock.mock.calls[1][0]).toContain(
        'gh issue edit 9 --body-file -'
      );
      expect(execMock.mock.calls[1][1].input).toContain('fresh reasons');
      // No create, and no label churn, on the refresh path.
      expect(execMock).toHaveBeenCalledTimes(2);
    });

    it('matches on the marker rather than the title, so a reword cannot orphan the issue', () => {
      const key = 'run-1/T-02/agent-timeout';
      execMock
        .mockReturnValueOnce(
          listing({
            number: 11,
            state: 'OPEN',
            body: `body\n${issueMarker(key)}`
          })
        )
        .mockReturnValueOnce('');

      const ref = repo.upsert({
        repoPath: '/repo',
        key,
        title: 'a completely different title',
        body: 'x',
        labels: []
      });

      expect(ref.number).toBe(11);
    });

    it('ignores an open issue whose marker belongs to another task', () => {
      execMock
        .mockReturnValueOnce(
          listing({
            number: 5,
            state: 'OPEN',
            body: issueMarker('run-1/T-99/no-commit')
          })
        )
        .mockReturnValueOnce('')
        .mockReturnValueOnce('https://github.com/o/r/issues/6\n');

      const ref = repo.upsert({
        repoPath: '/repo',
        key: 'run-1/T-01/no-commit',
        title: 't',
        body: 'b',
        labels: ['needs-human']
      });

      expect(ref.number).toBe(6);
    });

    it('escapes quotes in the title and labels so gh cannot mis-parse them', () => {
      execMock
        .mockReturnValueOnce('[]')
        .mockReturnValueOnce('')
        .mockReturnValueOnce('https://github.com/o/r/issues/8\n');

      repo.upsert({
        repoPath: '/repo',
        key: 'k',
        title: 'the "manual:" criterion',
        body: 'b',
        labels: ['needs "human"']
      });

      const created = execMock.mock.calls[2][0];
      expect(created).toContain('--title "the \\"manual:\\" criterion"');
      expect(created).toContain('--label "needs \\"human\\""');
    });

    it('throws typed when gh issue create returns no issue URL', () => {
      execMock
        .mockReturnValueOnce('[]')
        .mockReturnValueOnce('')
        .mockReturnValueOnce('gh: something went sideways');

      expect(() =>
        repo.upsert({
          repoPath: '/repo',
          key: 'k',
          title: 't',
          body: 'b',
          labels: ['needs-human']
        })
      ).toThrow(expect.objectContaining({ code: 'GH_FAILED' }));
    });
  });

  describe('findOpenByLabel', () => {
    it('returns open issues carrying the label', () => {
      execMock.mockReturnValue(
        listing({ number: 1, state: 'OPEN' }, { number: 2, state: 'open' })
      );

      const refs = repo.findOpenByLabel('/repo', 'needs-human');

      expect(refs).toEqual([
        { number: 1, url: 'https://github.com/o/r/issues/1', state: 'OPEN' },
        { number: 2, url: 'https://github.com/o/r/issues/2', state: 'OPEN' }
      ]);
      expect(execMock.mock.calls[0][0]).toContain('--label "needs-human"');
      expect(execMock.mock.calls[0][0]).toContain('--state open');
    });

    it('returns an empty list when nothing is open', () => {
      execMock.mockReturnValue('[]');

      expect(repo.findOpenByLabel('/repo', 'needs-human')).toEqual([]);
    });

    it('throws typed on unparseable JSON rather than reporting no blockers', () => {
      execMock.mockReturnValue('not json at all');

      expect(() => repo.findOpenByLabel('/repo', 'needs-human')).toThrow(
        expect.objectContaining({ code: 'GH_FAILED' })
      );
    });
  });

  describe('isResolved', () => {
    it('is true only once the issue is closed', () => {
      const key = 'run-1/T-01/merge-blocked';
      execMock
        .mockReturnValueOnce('[]') // no open match
        .mockReturnValueOnce(
          listing({ number: 3, state: 'CLOSED', body: issueMarker(key) })
        );

      expect(repo.isResolved('/repo', key)).toBe(true);
    });

    it('is false while the issue is still open', () => {
      const key = 'run-1/T-01/merge-blocked';
      execMock.mockReturnValueOnce(
        listing({ number: 3, state: 'OPEN', body: issueMarker(key) })
      );

      expect(repo.isResolved('/repo', key)).toBe(false);
      // Short-circuits: an open match makes the closed query pointless.
      expect(execMock).toHaveBeenCalledTimes(1);
    });

    it('is false when the escalation was never filed', () => {
      execMock.mockReturnValueOnce('[]').mockReturnValueOnce('[]');

      expect(repo.isResolved('/repo', 'run-1/T-01/no-commit')).toBe(false);
    });

    it('ignores issues that carry no body', () => {
      execMock.mockReturnValueOnce(listing({ number: 4, state: 'OPEN' }));
      execMock.mockReturnValueOnce('[]');

      expect(repo.isResolved('/repo', 'run-1/T-01/no-commit')).toBe(false);
    });
  });

  describe('ensureLabel', () => {
    it('force-creates the label so a colour change cannot fail the run', () => {
      execMock.mockReturnValue('');

      repo.ensureLabel('/repo', 'needs-human', 'B60205');

      expect(execMock.mock.calls[0][0]).toContain(
        'gh label create "needs-human" --color "B60205" --force'
      );
    });

    it('swallows failure so a token without label scope still files the issue', () => {
      execMock.mockImplementation(() => {
        throw new Error('HTTP 403: Resource not accessible by integration');
      });

      expect(() =>
        repo.ensureLabel('/repo', 'needs-human', 'B60205')
      ).not.toThrow();
    });

    it('does not abort upsert when label creation is refused', () => {
      execMock
        .mockReturnValueOnce('[]')
        .mockImplementationOnce(() => {
          throw new Error('HTTP 403');
        })
        .mockReturnValueOnce('https://github.com/o/r/issues/12\n');

      const ref = repo.upsert({
        repoPath: '/repo',
        key: 'k',
        title: 't',
        body: 'b',
        labels: ['needs-human']
      });

      expect(ref.number).toBe(12);
    });
  });

  it('throws typed when gh itself fails, carrying the tool output', () => {
    execMock.mockImplementation(() => {
      throw new Error('gh: Not Found (HTTP 404)');
    });

    expect(() => repo.findOpenByLabel('/repo', 'needs-human')).toThrow(
      expect.objectContaining({ code: 'GH_FAILED' })
    );
  });

  it('runs every gh call in the target repo', () => {
    execMock.mockReturnValue('[]');

    repo.findOpenByLabel('/some/repo', 'needs-human');

    expect(execMock.mock.calls[0][1].cwd).toBe('/some/repo');
  });
});
