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
});
