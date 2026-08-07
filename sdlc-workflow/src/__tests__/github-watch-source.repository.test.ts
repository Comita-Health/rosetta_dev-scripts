jest.mock('../utils/gh-cli', () => ({ runGh: jest.fn() }));

import { mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { DaemonConfigRepository } from '../repositories/daemon-config.repository';
import { GitHubWatchSourceRepository } from '../repositories/github-watch-source.repository';
import { runGh } from '../utils/gh-cli';

const ghMock = runGh as jest.Mock;

const workspaceWithConfig = (): string => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'gh-watch-src-'));
  mkdirSync(path.join(root, '.sdlc'), { recursive: true });
  writeFileSync(
    path.join(root, '.sdlc', 'daemon.json'),
    JSON.stringify({
      activateScript: path.join(root, 'activate.sh'),
      runsDir: 'var/runs',
      defaultPollSeconds: 30,
      headlessRunner: 'test-runner'
    }),
    'utf-8'
  );
  return root;
};

describe('GitHubWatchSourceRepository', () => {
  const repo = new GitHubWatchSourceRepository(new DaemonConfigRepository());

  beforeEach(() => ghMock.mockReset());

  it('loads the PR head under the workspace Addi activate script', () => {
    const workspace = workspaceWithConfig();
    ghMock.mockReturnValue(
      JSON.stringify({ state: 'OPEN', headRefOid: 'abc123' })
    );

    expect(repo.getPullRequest(workspace, 'Acme/widgets', 9)).toEqual({
      state: 'OPEN',
      headSha: 'abc123'
    });
    expect(ghMock).toHaveBeenCalledWith(
      workspace,
      expect.stringContaining('gh pr view 9 -R "Acme/widgets"'),
      expect.objectContaining({
        requireAddi: true,
        owner: 'Acme',
        env: { SDLC_GH_ACTIVATE: path.join(workspace, 'activate.sh') }
      })
    );
  });

  it('lists reviews and review comments from the REST collection endpoints', () => {
    const workspace = workspaceWithConfig();
    ghMock
      .mockReturnValueOnce(
        JSON.stringify([
          {
            id: 1,
            state: 'APPROVED',
            body: 'ok',
            submitted_at: '2026-08-07T10:00:00Z',
            user: { login: 'alice', type: 'User' }
          }
        ])
      )
      .mockReturnValueOnce(
        JSON.stringify([
          {
            id: 2,
            body: 'nit',
            path: 'a.ts',
            created_at: '2026-08-07T10:01:00Z',
            user: { login: 'bob', type: 'User' }
          }
        ])
      );

    expect(repo.listReviews(workspace, 'Acme/widgets', 9)).toEqual([
      {
        id: 1,
        state: 'APPROVED',
        body: 'ok',
        submittedAt: '2026-08-07T10:00:00Z',
        userLogin: 'alice',
        userType: 'User'
      }
    ]);
    expect(repo.listReviewComments(workspace, 'Acme/widgets', 9)).toEqual([
      {
        id: 2,
        body: 'nit',
        path: 'a.ts',
        createdAt: '2026-08-07T10:01:00Z',
        userLogin: 'bob',
        userType: 'User'
      }
    ]);
  });

  it('lists check runs and combined status for a commit SHA', () => {
    const workspace = workspaceWithConfig();
    ghMock
      .mockReturnValueOnce(
        JSON.stringify([
          {
            id: 3,
            name: 'ci',
            status: 'completed',
            conclusion: 'success',
            completed_at: '2026-08-07T10:02:00Z'
          }
        ])
      )
      .mockReturnValueOnce(
        JSON.stringify({
          state: 'success',
          statuses: [
            {
              context: 'ci',
              state: 'success',
              updated_at: '2026-08-07T10:02:00Z'
            }
          ]
        })
      );

    expect(repo.listCheckRuns(workspace, 'Acme/widgets', 'sha')).toEqual([
      {
        id: 3,
        name: 'ci',
        status: 'completed',
        conclusion: 'success',
        completedAt: '2026-08-07T10:02:00Z'
      }
    ]);
    expect(repo.getCombinedStatus(workspace, 'Acme/widgets', 'sha')).toEqual({
      state: 'success',
      statuses: [
        {
          context: 'ci',
          state: 'success',
          updatedAt: '2026-08-07T10:02:00Z'
        }
      ]
    });
  });

  it('rejects a target repo that is not owner/name', () => {
    const workspace = workspaceWithConfig();

    expect(() => repo.getPullRequest(workspace, 'widgets', 9)).toThrow(
      /owner\/name/
    );
    expect(() => repo.listReviews(workspace, '/widgets', 9)).toThrow(
      /owner\/name/
    );
    expect(ghMock).not.toHaveBeenCalled();
  });

  it('reports unparseable gh output as a GH_FAILED workflow error', () => {
    const workspace = workspaceWithConfig();
    ghMock.mockReturnValue('not json');

    expect(() => repo.listCheckRuns(workspace, 'Acme/widgets', 'sha')).toThrow(
      expect.objectContaining({ code: 'GH_FAILED' })
    );
  });

  // A PR view without a head SHA leaves the checks adapter nothing to key on,
  // so it fails loudly rather than polling a phantom commit.
  it('rejects a PR view with no head SHA', () => {
    const workspace = workspaceWithConfig();
    ghMock
      .mockReturnValueOnce(JSON.stringify({ state: 'OPEN', headRefOid: ' ' }))
      .mockReturnValueOnce(JSON.stringify({ state: 'OPEN' }));

    expect(() => repo.getPullRequest(workspace, 'Acme/widgets', 9)).toThrow(
      expect.objectContaining({ code: 'GH_FAILED' })
    );
    expect(() => repo.getPullRequest(workspace, 'Acme/widgets', 9)).toThrow(
      expect.objectContaining({ code: 'GH_FAILED' })
    );
  });

  it('defaults a missing or empty PR state to OPEN', () => {
    const workspace = workspaceWithConfig();
    ghMock
      .mockReturnValueOnce(JSON.stringify({ headRefOid: 'abc123' }))
      .mockReturnValueOnce(JSON.stringify({ state: '', headRefOid: 'abc123' }));

    expect(repo.getPullRequest(workspace, 'Acme/widgets', 9)).toEqual({
      state: 'OPEN',
      headSha: 'abc123'
    });
    expect(repo.getPullRequest(workspace, 'Acme/widgets', 9)).toEqual({
      state: 'OPEN',
      headSha: 'abc123'
    });
  });

  it('normalizes reviews and comments with missing author or body fields', () => {
    const workspace = workspaceWithConfig();
    ghMock
      .mockReturnValueOnce(
        JSON.stringify([
          {
            id: 1,
            state: 'APPROVED',
            body: null,
            submitted_at: '',
            user: null
          },
          { id: 2, state: 'APPROVED', user: {} }
        ])
      )
      .mockReturnValueOnce(
        JSON.stringify([
          { id: 3, created_at: '2026-08-07T10:01:00Z' },
          {
            id: 4,
            body: null,
            path: null,
            created_at: '2026-08-07T10:02:00Z',
            user: { login: 42, type: 7 }
          }
        ])
      );

    expect(repo.listReviews(workspace, 'Acme/widgets', 9)).toEqual([
      {
        id: 1,
        state: 'APPROVED',
        body: '',
        submittedAt: null,
        userLogin: '',
        userType: 'User'
      },
      {
        id: 2,
        state: 'APPROVED',
        body: '',
        submittedAt: null,
        userLogin: '',
        userType: 'User'
      }
    ]);
    expect(repo.listReviewComments(workspace, 'Acme/widgets', 9)).toEqual([
      {
        id: 3,
        body: '',
        path: '',
        createdAt: '2026-08-07T10:01:00Z',
        userLogin: '',
        userType: 'User'
      },
      {
        id: 4,
        body: '',
        path: '',
        createdAt: '2026-08-07T10:02:00Z',
        userLogin: '',
        userType: 'User'
      }
    ]);
  });

  it('defaults an absent or empty combined status to pending with no contexts', () => {
    const workspace = workspaceWithConfig();
    ghMock
      .mockReturnValueOnce(JSON.stringify({}))
      .mockReturnValueOnce(JSON.stringify({ state: '', statuses: [] }));

    expect(repo.getCombinedStatus(workspace, 'Acme/widgets', 'sha')).toEqual({
      state: 'pending',
      statuses: []
    });
    expect(repo.getCombinedStatus(workspace, 'Acme/widgets', 'sha')).toEqual({
      state: 'pending',
      statuses: []
    });
  });
});
