import 'reflect-metadata';

import { Container } from 'inversify';
import type { ICiStatusRepository } from '../repositories/ci-status.repository';
import type { IPullRequestRepository } from '../repositories/pull-request.repository';
import {
  IReviewerPublishService,
  ReviewerPublishService
} from '../services/reviewer-publish.service';
import { WORKFLOW_TOKENS } from '../tokens';
import type { GateVerdict } from '../types';
import {
  formatReviewerPrComment,
  parsePrNumber,
  REVIEWER_STATUS_CONTEXT,
  reviewerStatusState,
  truncateStatusDescription
} from '../utils/reviewer-publish';

const passVerdict = (): GateVerdict => ({
  gate: 'reviewer',
  outcome: 'pass',
  wouldEscalate: false,
  reasons: ['matches acceptance criteria'],
  recordedAt: '2026-08-02T00:00:00.000Z'
});

const breachVerdict = (): GateVerdict => ({
  gate: 'reviewer',
  outcome: 'breach',
  wouldEscalate: true,
  reasons: ['empty diff', 'missing test'],
  recordedAt: '2026-08-02T00:00:00.000Z'
});

describe('reviewer-publish utils', () => {
  it('parses PR numbers from GitHub URLs', () => {
    expect(parsePrNumber('https://github.com/org/repo/pull/264')).toBe(264);
    expect(parsePrNumber('https://github.com/org/repo/pull/264/files')).toBe(
      264
    );
    expect(parsePrNumber(undefined)).toBeNull();
    expect(parsePrNumber('not-a-url')).toBeNull();
  });

  it('truncates status descriptions to 140 chars', () => {
    expect(truncateStatusDescription('short')).toBe('short');
    const long = 'x'.repeat(200);
    const truncated = truncateStatusDescription(long);
    expect(truncated.length).toBe(140);
    expect(truncated.endsWith('…')).toBe(true);
  });

  it('maps verdicts to commit-status states', () => {
    expect(reviewerStatusState('pass')).toBe('success');
    expect(reviewerStatusState('breach')).toBe('failure');
    expect(reviewerStatusState('blocked')).toBe('error');
  });

  it('formats a PR overview comment', () => {
    const body = formatReviewerPrComment({
      runId: 'prd-0004-p0a-2026-08-01',
      taskId: 'T-02',
      verdict: breachVerdict(),
      shadow: true
    });
    expect(body).toContain('sdlc-workflow reviewer (shadow)');
    expect(body).toContain('**Task:** `T-02`');
    expect(body).toContain('breach (disagree)');
    expect(body).toContain('- empty diff');
    expect(body).toContain('Would escalate under enforcement');
  });

  it('formats enforce-mode comments with empty reasons and other outcomes', () => {
    const body = formatReviewerPrComment({
      runId: 'run-1',
      taskId: 'T-01',
      shadow: false,
      verdict: {
        gate: 'reviewer',
        outcome: 'human-required',
        wouldEscalate: false,
        reasons: [],
        recordedAt: '2026-08-02T00:00:00.000Z'
      }
    });
    expect(body).toContain('reviewer (enforce)');
    expect(body).toContain('**human-required**');
    expect(body).toContain('_(no reasons recorded)_');
    expect(body).not.toContain('Would escalate');
  });
});

describe('ReviewerPublishService', () => {
  let createStatus: jest.Mock;
  let comment: jest.Mock;
  let service: IReviewerPublishService;

  beforeEach(() => {
    createStatus = jest.fn();
    comment = jest.fn();
    const container = new Container();
    container
      .bind<IPullRequestRepository>(WORKFLOW_TOKENS.PullRequestRepository)
      .toConstantValue({
        findByBranch: jest.fn(),
        create: jest.fn(),
        merge: jest.fn(),
        comment
      });
    container
      .bind<ICiStatusRepository>(WORKFLOW_TOKENS.CiStatusRepository)
      .toConstantValue({
        checkRuns: jest.fn(),
        failedLogs: jest.fn(),
        createStatus
      });
    container
      .bind<IReviewerPublishService>(WORKFLOW_TOKENS.ReviewerPublishService)
      .to(ReviewerPublishService);
    service = container.get(WORKFLOW_TOKENS.ReviewerPublishService);
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    (console.log as jest.Mock).mockRestore();
  });

  it('marks pending via commit status', () => {
    service.markPending({
      repoPath: '/repo',
      prUrl: 'https://github.com/org/repo/pull/7',
      headSha: 'abc123',
      runId: 'run-1',
      taskId: 'T-01',
      shadow: true
    });

    expect(createStatus).toHaveBeenCalledWith('/repo', 'abc123', {
      state: 'pending',
      context: REVIEWER_STATUS_CONTEXT,
      description: expect.stringContaining('Reviewing T-01')
    });
  });

  it('publishes success status and PR comment on pass', () => {
    service.publishResult({
      repoPath: '/repo',
      prUrl: 'https://github.com/org/repo/pull/7',
      headSha: 'abc123',
      runId: 'run-1',
      taskId: 'T-01',
      shadow: true,
      verdict: passVerdict()
    });

    expect(createStatus).toHaveBeenCalledWith(
      '/repo',
      'abc123',
      expect.objectContaining({
        state: 'success',
        context: REVIEWER_STATUS_CONTEXT,
        targetUrl: 'https://github.com/org/repo/pull/7'
      })
    );
    expect(comment).toHaveBeenCalledWith(
      '/repo',
      7,
      expect.stringContaining('pass (concur)')
    );
  });

  it('publishes failure status and does not throw when comment fails', () => {
    comment.mockImplementation(() => {
      throw new Error('gh pr comment failed');
    });

    expect(() =>
      service.publishResult({
        repoPath: '/repo',
        prUrl: 'https://github.com/org/repo/pull/9',
        headSha: 'def456',
        runId: 'run-1',
        taskId: 'T-02',
        shadow: false,
        verdict: breachVerdict()
      })
    ).not.toThrow();

    expect(createStatus).toHaveBeenCalledWith(
      '/repo',
      'def456',
      expect.objectContaining({ state: 'failure' })
    );
  });

  it('skips comment when PR URL is missing but still posts status', () => {
    service.publishResult({
      repoPath: '/repo',
      prUrl: undefined,
      headSha: 'abc',
      runId: 'run-1',
      taskId: 'T-01',
      shadow: true,
      verdict: passVerdict()
    });

    expect(createStatus).toHaveBeenCalled();
    expect(comment).not.toHaveBeenCalled();
  });

  it('skips status when headSha is empty', () => {
    service.markPending({
      repoPath: '/repo',
      prUrl: 'https://github.com/org/repo/pull/1',
      headSha: '',
      runId: 'run-1',
      taskId: 'T-01',
      shadow: true
    });
    expect(createStatus).not.toHaveBeenCalled();
  });

  it('swallows createStatus failures without throwing', () => {
    createStatus.mockImplementation(() => {
      throw 'raw failure';
    });

    expect(() =>
      service.markPending({
        repoPath: '/repo',
        prUrl: 'https://github.com/org/repo/pull/1',
        headSha: 'abc',
        runId: 'run-1',
        taskId: 'T-01',
        shadow: true
      })
    ).not.toThrow();
  });

  it('uses first-reason fallback when reasons are empty', () => {
    service.publishResult({
      repoPath: '/repo',
      prUrl: 'https://github.com/org/repo/pull/3',
      headSha: 'sha',
      runId: 'run-1',
      taskId: 'T-03',
      shadow: true,
      verdict: {
        gate: 'reviewer',
        outcome: 'pass',
        wouldEscalate: false,
        reasons: [],
        recordedAt: '2026-08-02T00:00:00.000Z'
      }
    });

    expect(createStatus).toHaveBeenCalledWith(
      '/repo',
      'sha',
      expect.objectContaining({
        description: expect.stringContaining('T-03: pass — pass')
      })
    );
  });
});
