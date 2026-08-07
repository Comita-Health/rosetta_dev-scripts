import {
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync
} from 'fs';
import os from 'os';
import path from 'path';
import { DaemonStoreRepository } from '../repositories/daemon-store.repository';
import type { IGitHubWatchSourceRepository } from '../repositories/github-watch-source.repository';
import { PollSchedulerService } from '../services/poll-scheduler.service';
import { PrChecksWatchSourceAdapter } from '../services/pr-checks-watch-source.adapter';
import { PrReviewWatchSourceAdapter } from '../services/pr-review-watch-source.adapter';
import { WatchSourceAdapterRegistry } from '../services/watch-source-adapter';
import { WatchRegistryService } from '../services/watch-registry.service';
import { commitWatchSignal } from '../utils/watch-wake-commit';
import type { DurableWatchRecord, WakeEvent } from '../types';

const ADAPTER_DIR = path.join(__dirname, '..', 'services');
const ADAPTER_FILES = [
  'pr-review-watch-source.adapter.ts',
  'pr-checks-watch-source.adapter.ts'
] as const;

const FORBIDDEN_WAKE_WRITE_PATTERNS = [
  /daemon-store\.repository/,
  /wake-inbox\.repository/,
  /watch-wake-commit/,
  /\bwriteWake\b/,
  /\bemitOnce\b/,
  /\bcommitWatchSignal\b/
];

const writeDaemonConfig = (root: string): void => {
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
};

const prWatch = (
  kind: 'pr-review' | 'pr-checks',
  repo = 'owner/repo',
  number = 42
): DurableWatchRecord => ({
  id: `${kind}:${repo.toLowerCase()}#${number}`,
  kind,
  target: { repo, number },
  pollSeconds: 30,
  createdBy: 'test',
  createdAt: '2026-08-07T10:00:00.000Z'
});

const githubStub = (
  overrides: Partial<IGitHubWatchSourceRepository> = {}
): IGitHubWatchSourceRepository => ({
  getPullRequest: jest.fn().mockReturnValue({
    state: 'OPEN',
    headSha: 'abc123def456'
  }),
  listReviews: jest.fn().mockReturnValue([]),
  listReviewComments: jest.fn().mockReturnValue([]),
  listCheckRuns: jest.fn().mockReturnValue([]),
  getCombinedStatus: jest.fn().mockReturnValue({
    state: 'pending',
    statuses: []
  }),
  ...overrides
});

describe('watch source adapters (SPEC-PRD-0020-P1 T-05)', () => {
  describe('module boundary', () => {
    it('cannot write to the wake store except via the shared inbox writer', () => {
      for (const file of ADAPTER_FILES) {
        const source = readFileSync(path.join(ADAPTER_DIR, file), 'utf-8');
        for (const pattern of FORBIDDEN_WAKE_WRITE_PATTERNS) {
          expect(source).not.toMatch(pattern);
        }
      }
      // Phase 3 kinds must not be stubbed beside the two Phase 1 adapters.
      const serviceFiles = readdirSync(ADAPTER_DIR).filter(name =>
        name.endsWith('-watch-source.adapter.ts')
      );
      expect(serviceFiles.sort()).toEqual([
        'pr-checks-watch-source.adapter.ts',
        'pr-review-watch-source.adapter.ts'
      ]);
    });
  });

  describe('PrReviewWatchSourceAdapter', () => {
    it('emits distinct normalized signals for Approve, Request-changes, and review comments through the shared write path', async () => {
      const github = githubStub({
        listReviews: jest.fn().mockReturnValue([
          {
            id: 11,
            state: 'APPROVED',
            userLogin: 'alice',
            userType: 'User',
            submittedAt: '2026-08-07T10:01:00.000Z',
            body: 'lgtm'
          },
          {
            id: 12,
            state: 'CHANGES_REQUESTED',
            userLogin: 'bob',
            userType: 'User',
            submittedAt: '2026-08-07T10:02:00.000Z',
            body: 'please fix'
          },
          {
            id: 13,
            state: 'APPROVED',
            userLogin: 'copilot[bot]',
            userType: 'Bot',
            submittedAt: '2026-08-07T10:03:00.000Z',
            body: 'bot approve'
          }
        ]),
        listReviewComments: jest.fn().mockReturnValue([
          {
            id: 99,
            userLogin: 'carol',
            userType: 'User',
            createdAt: '2026-08-07T10:04:00.000Z',
            body: 'nit',
            path: 'src/a.ts'
          }
        ])
      });
      const adapter = new PrReviewWatchSourceAdapter(github);
      const workspace = mkdtempSync(
        path.join(os.tmpdir(), 'pr-review-adapter-')
      );
      writeDaemonConfig(workspace);
      const watch = prWatch('pr-review');
      const store = new DaemonStoreRepository();

      const result = await adapter.poll(workspace, watch);
      expect(result.signals.map(signal => signal.id)).toEqual([
        'approved:11',
        'changes_requested:12',
        'review_comment:99'
      ]);
      expect(result.signals.map(signal => signal.data?.signal)).toEqual([
        'approved',
        'changes_requested',
        'review_comment'
      ]);

      for (const signal of result.signals) {
        commitWatchSignal(store, workspace, watch, signal);
      }

      const wakes = store.listPendingWakes(workspace);
      expect(wakes).toHaveLength(3);
      expect(wakes.map(wake => wake.signal).sort()).toEqual([
        'approved:11',
        'changes_requested:12',
        'review_comment:99'
      ]);
      for (const wake of wakes) {
        expect(wake).toEqual(
          expect.objectContaining({
            kind: 'pr-review',
            target: watch.id,
            signal: expect.any(String),
            createdAt: expect.any(String),
            id: expect.any(String)
          })
        );
      }
    });

    it('ignores review states that are neither Approve nor Request-changes', async () => {
      const github = githubStub({
        listReviews: jest.fn().mockReturnValue([
          {
            id: 21,
            state: 'COMMENTED',
            userLogin: 'alice',
            userType: 'User',
            submittedAt: '2026-08-07T10:01:00.000Z',
            body: 'thoughts'
          },
          {
            id: 22,
            state: 'DISMISSED',
            userLogin: 'bob',
            userType: 'User',
            submittedAt: '2026-08-07T10:02:00.000Z',
            body: ''
          }
        ]),
        listReviewComments: jest.fn().mockReturnValue([
          {
            id: 23,
            userLogin: 'copilot[bot]',
            userType: 'Bot',
            createdAt: '2026-08-07T10:03:00.000Z',
            body: 'bot nit',
            path: 'src/a.ts'
          }
        ])
      });
      const adapter = new PrReviewWatchSourceAdapter(github);

      await expect(
        adapter.poll('/workspace', prWatch('pr-review'))
      ).resolves.toEqual({ signals: [] });
    });

    // A review row can arrive without a usable submitted_at (pending reviews,
    // or a malformed timestamp); the wake still needs an observedAt.
    it('falls back to poll time when the review timestamp is missing or unparseable', async () => {
      const github = githubStub({
        listReviews: jest.fn().mockReturnValue([
          {
            id: 31,
            state: 'APPROVED',
            userLogin: 'alice',
            userType: 'User',
            submittedAt: null,
            body: ''
          },
          {
            id: 32,
            state: 'CHANGES_REQUESTED',
            userLogin: 'bob',
            userType: 'User',
            submittedAt: 'not-a-timestamp',
            body: 'fix'
          }
        ]),
        listReviewComments: jest.fn().mockReturnValue([
          {
            id: 33,
            userLogin: 'carol',
            userType: 'User',
            createdAt: 'also-not-a-timestamp',
            body: 'nit',
            path: 'src/a.ts'
          }
        ])
      });
      const adapter = new PrReviewWatchSourceAdapter(github);

      const result = await adapter.poll('/workspace', prWatch('pr-review'));

      expect(result.signals).toHaveLength(3);
      for (const signal of result.signals) {
        expect(Number.isNaN(Date.parse(signal.observedAt))).toBe(false);
      }
    });

    it('rejects a watch whose target is not a pull request', async () => {
      const adapter = new PrReviewWatchSourceAdapter(githubStub());
      const base = prWatch('pr-review');

      await expect(
        adapter.poll('/workspace', { ...base, target: { number: 42 } })
      ).rejects.toThrow(/target\.repo/);
      await expect(
        adapter.poll('/workspace', {
          ...base,
          target: { repo: '   ', number: 42 }
        })
      ).rejects.toThrow(/target\.repo/);
      await expect(
        adapter.poll('/workspace', { ...base, target: { repo: 'owner/repo' } })
      ).rejects.toThrow(/target\.number/);
      await expect(
        adapter.poll('/workspace', {
          ...base,
          target: { repo: 'owner/repo', number: 1.5 }
        })
      ).rejects.toThrow(/target\.number/);
    });

    it('expires a merged PR via terminalState without emitting review wakes', async () => {
      const github = githubStub({
        getPullRequest: jest.fn().mockReturnValue({
          state: 'MERGED',
          headSha: 'deadbeef'
        }),
        listReviews: jest.fn().mockReturnValue([
          {
            id: 1,
            state: 'APPROVED',
            userLogin: 'alice',
            userType: 'User',
            submittedAt: '2026-08-07T10:01:00.000Z',
            body: ''
          }
        ])
      });
      const adapter = new PrReviewWatchSourceAdapter(github);
      const result = await adapter.poll('/workspace', prWatch('pr-review'));
      expect(result).toEqual({ signals: [], terminalState: 'merged' });
      expect(github.listReviews).not.toHaveBeenCalled();
    });
  });

  describe('PrChecksWatchSourceAdapter', () => {
    it('emits a normalized signal for a CI terminal failure through the shared write path', async () => {
      const github = githubStub({
        listCheckRuns: jest.fn().mockReturnValue([
          {
            id: 1,
            name: 'ci',
            status: 'completed',
            conclusion: 'failure',
            completedAt: '2026-08-07T10:05:00.000Z'
          },
          {
            id: 2,
            name: 'lint',
            status: 'completed',
            conclusion: 'success',
            completedAt: '2026-08-07T10:04:00.000Z'
          }
        ]),
        getCombinedStatus: jest.fn().mockReturnValue({
          state: 'failure',
          statuses: [
            {
              context: 'context/ci',
              state: 'failure',
              updatedAt: '2026-08-07T10:05:00.000Z'
            }
          ]
        })
      });
      const adapter = new PrChecksWatchSourceAdapter(github);
      const workspace = mkdtempSync(
        path.join(os.tmpdir(), 'pr-checks-adapter-')
      );
      writeDaemonConfig(workspace);
      const watch = prWatch('pr-checks');
      const store = new DaemonStoreRepository();

      const result = await adapter.poll(workspace, watch);
      expect(result.signals).toHaveLength(1);
      expect(result.signals[0]).toMatchObject({
        id: 'checks_failed:abc123def456',
        data: {
          signal: 'checks_failed',
          sha: 'abc123def456',
          failedChecks: ['ci']
        }
      });

      commitWatchSignal(store, workspace, watch, result.signals[0]);
      const wakes = store.listPendingWakes(workspace);
      expect(wakes).toHaveLength(1);
      expect(wakes[0]).toEqual(
        expect.objectContaining({
          kind: 'pr-checks',
          target: watch.id,
          signal: 'checks_failed:abc123def456',
          createdAt: '2026-08-07T10:05:00.000Z',
          id: expect.any(String)
        })
      );
    });

    it('emits a normalized signal for a CI terminal success', async () => {
      const github = githubStub({
        listCheckRuns: jest.fn().mockReturnValue([
          {
            id: 1,
            name: 'ci',
            status: 'completed',
            conclusion: 'success',
            completedAt: '2026-08-07T10:06:00.000Z'
          }
        ]),
        getCombinedStatus: jest.fn().mockReturnValue({
          state: 'success',
          statuses: [
            {
              context: 'context/ci',
              state: 'success',
              updatedAt: '2026-08-07T10:06:00.000Z'
            }
          ]
        })
      });
      const adapter = new PrChecksWatchSourceAdapter(github);
      const result = await adapter.poll('/workspace', prWatch('pr-checks'));
      expect(result.signals).toHaveLength(1);
      expect(result.signals[0].id).toBe('checks_success:abc123def456');
      expect(result.signals[0].data?.signal).toBe('checks_success');
    });

    it('emits nothing while checks or status contexts are still pending', async () => {
      const github = githubStub({
        listCheckRuns: jest.fn().mockReturnValue([
          {
            id: 1,
            name: 'ci',
            status: 'in_progress',
            conclusion: null,
            completedAt: null
          }
        ]),
        getCombinedStatus: jest.fn().mockReturnValue({
          state: 'pending',
          statuses: []
        })
      });
      const adapter = new PrChecksWatchSourceAdapter(github);
      await expect(
        adapter.poll('/workspace', prWatch('pr-checks'))
      ).resolves.toEqual({ signals: [] });
    });

    // Green with no CI configured is indistinguishable from CI that has not
    // reported yet, so the adapter keeps polling instead of waking on nothing.
    it('emits nothing when the head SHA has no CI surface at all', async () => {
      const github = githubStub({
        getCombinedStatus: jest
          .fn()
          .mockReturnValue({ state: 'success', statuses: [] })
      });
      const adapter = new PrChecksWatchSourceAdapter(github);

      await expect(
        adapter.poll('/workspace', prWatch('pr-checks'))
      ).resolves.toEqual({ signals: [] });
    });

    it('treats a completed run with no conclusion as failing and falls back to poll time', async () => {
      const github = githubStub({
        listCheckRuns: jest.fn().mockReturnValue([
          {
            id: 1,
            name: 'ci',
            status: 'completed',
            conclusion: null,
            completedAt: null
          },
          {
            id: 2,
            name: 'skipped-job',
            status: 'completed',
            conclusion: 'skipped',
            completedAt: null
          }
        ]),
        getCombinedStatus: jest.fn().mockReturnValue({
          state: 'success',
          statuses: [
            { context: 'ci', state: 'success', updatedAt: 'not-a-timestamp' }
          ]
        })
      });
      const adapter = new PrChecksWatchSourceAdapter(github);

      const result = await adapter.poll('/workspace', prWatch('pr-checks'));

      expect(result.signals).toHaveLength(1);
      expect(result.signals[0]).toMatchObject({
        id: 'checks_failed:abc123def456',
        data: { failedChecks: ['ci'] }
      });
      expect(Number.isNaN(Date.parse(result.signals[0].observedAt))).toBe(
        false
      );
    });

    // The Checks API can be entirely green while a legacy status context is
    // red; the commit status is the authority for those.
    it('reports a failure from the commit status when every check run passed', async () => {
      const github = githubStub({
        listCheckRuns: jest.fn().mockReturnValue([
          {
            id: 1,
            name: 'ci',
            status: 'completed',
            conclusion: 'neutral',
            completedAt: '2026-08-07T10:07:00.000Z'
          }
        ]),
        getCombinedStatus: jest.fn().mockReturnValue({
          state: 'error',
          statuses: [
            {
              context: 'legacy/deploy',
              state: 'error',
              updatedAt: '2026-08-07T10:08:00.000Z'
            }
          ]
        })
      });
      const adapter = new PrChecksWatchSourceAdapter(github);

      const result = await adapter.poll('/workspace', prWatch('pr-checks'));

      expect(result.signals).toHaveLength(1);
      expect(result.signals[0]).toMatchObject({
        id: 'checks_failed:abc123def456',
        observedAt: '2026-08-07T10:08:00.000Z',
        data: { failedChecks: [], statusState: 'error' }
      });
    });

    it('expires a closed PR via terminalState without reading CI', async () => {
      const github = githubStub({
        getPullRequest: jest
          .fn()
          .mockReturnValue({ state: 'CLOSED', headSha: 'abc123def456' })
      });
      const adapter = new PrChecksWatchSourceAdapter(github);

      await expect(
        adapter.poll('/workspace', prWatch('pr-checks'))
      ).resolves.toEqual({ signals: [], terminalState: 'closed' });
      expect(github.listCheckRuns).not.toHaveBeenCalled();
      expect(github.getCombinedStatus).not.toHaveBeenCalled();
    });

    it('rejects a watch whose target is not a pull request', async () => {
      const adapter = new PrChecksWatchSourceAdapter(githubStub());
      const base = prWatch('pr-checks');

      await expect(
        adapter.poll('/workspace', { ...base, target: {} })
      ).rejects.toThrow(/target\.repo/);
      await expect(
        adapter.poll('/workspace', { ...base, target: { repo: '  ' } })
      ).rejects.toThrow(/target\.repo/);
      await expect(
        adapter.poll('/workspace', { ...base, target: { repo: 'owner/repo' } })
      ).rejects.toThrow(/target\.number/);
      await expect(
        adapter.poll('/workspace', {
          ...base,
          target: { repo: 'owner/repo', number: Number.NaN }
        })
      ).rejects.toThrow(/target\.number/);
    });
  });

  describe('shared wake field schema', () => {
    it('lands Approve and CI terminal-state wakes with the same field schema', async () => {
      const workspace = mkdtempSync(path.join(os.tmpdir(), 'watch-schema-'));
      writeDaemonConfig(workspace);
      const store = new DaemonStoreRepository();
      const watches = new WatchRegistryService(store);
      const reviewWatch = watches.register(workspace, {
        kind: 'pr-review',
        target: { repo: 'owner/repo', number: 7 },
        pollSeconds: 30,
        createdBy: 'test'
      });
      const checksWatch = watches.register(workspace, {
        kind: 'pr-checks',
        target: { repo: 'owner/repo', number: 7 },
        pollSeconds: 30,
        createdBy: 'test'
      });

      const reviewAdapter = new PrReviewWatchSourceAdapter(
        githubStub({
          listReviews: jest.fn().mockReturnValue([
            {
              id: 55,
              state: 'APPROVED',
              userLogin: 'alice',
              userType: 'User',
              submittedAt: '2026-08-07T11:00:00.000Z',
              body: 'ship it'
            }
          ])
        })
      );
      const checksAdapter = new PrChecksWatchSourceAdapter(
        githubStub({
          listCheckRuns: jest.fn().mockReturnValue([
            {
              id: 1,
              name: 'ci',
              status: 'completed',
              conclusion: 'success',
              completedAt: '2026-08-07T11:01:00.000Z'
            }
          ]),
          getCombinedStatus: jest.fn().mockReturnValue({
            state: 'success',
            statuses: [
              {
                context: 'ci',
                state: 'success',
                updatedAt: '2026-08-07T11:01:00.000Z'
              }
            ]
          })
        })
      );

      const adapters = new WatchSourceAdapterRegistry();
      adapters.register('pr-review', reviewAdapter);
      adapters.register('pr-checks', checksAdapter);
      const scheduler = new PollSchedulerService(watches, store, adapters);

      await scheduler.tick(workspace);

      const wakes = store.listPendingWakes(workspace);
      expect(wakes).toHaveLength(2);

      const schemaKeys = (wake: WakeEvent): string[] =>
        Object.keys(wake).sort();
      expect(schemaKeys(wakes[0])).toEqual(schemaKeys(wakes[1]));
      expect(schemaKeys(wakes[0])).toEqual(
        ['createdAt', 'data', 'id', 'kind', 'prompt', 'signal', 'target'].sort()
      );

      const byKind = Object.fromEntries(wakes.map(wake => [wake.kind, wake]));
      expect(byKind['pr-review']).toMatchObject({
        kind: 'pr-review',
        target: reviewWatch.id,
        signal: 'approved:55'
      });
      expect(byKind['pr-checks']).toMatchObject({
        kind: 'pr-checks',
        target: checksWatch.id,
        signal: 'checks_success:abc123def456'
      });
    });
  });
});
