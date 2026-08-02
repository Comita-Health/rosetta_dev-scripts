import 'reflect-metadata';
import { Container } from 'inversify';
import type { IGitHubIssueRepository } from '../repositories/github-issue.repository';
import type { IQueueRepository } from '../repositories/queue.repository';
import {
  EscalationService,
  IEscalationService,
  NEEDS_HUMAN_LABEL,
  escalationTitle
} from '../services/escalation.service';
import { WORKFLOW_TOKENS } from '../tokens';
import { ExceptionEntry } from '../types';

const entry = (
  trigger: ExceptionEntry['trigger'],
  taskId = 'T-01'
): ExceptionEntry => ({
  trigger,
  taskId,
  context: [`${trigger} detail`],
  recordedAt: 'x'
});

describe('EscalationService (P3 T-06)', () => {
  let service: IEscalationService;
  let appendItem: jest.Mock;
  let upsert: jest.Mock;

  beforeEach(() => {
    appendItem = jest.fn().mockReturnValue(true);
    upsert = jest.fn().mockReturnValue({
      number: 7,
      url: 'https://github.com/o/r/issues/7',
      state: 'OPEN'
    });
    const container = new Container();
    container
      .bind<IQueueRepository>(WORKFLOW_TOKENS.QueueRepository)
      .toConstantValue({ appendItem, itemTags: jest.fn() });
    container
      .bind<IGitHubIssueRepository>(WORKFLOW_TOKENS.GitHubIssueRepository)
      .toConstantValue({
        upsert,
        findOpenByLabel: jest.fn(),
        isResolved: jest.fn(),
        ensureLabel: jest.fn()
      });
    container
      .bind<IEscalationService>(WORKFLOW_TOKENS.EscalationService)
      .to(EscalationService);
    service = container.get(WORKFLOW_TOKENS.EscalationService);
  });

  it.each([
    'reviewer-disagreement',
    'ci-fix-attempts-exhausted',
    'envelope-breach',
    'budget-exhaustion'
  ] as const)(
    'posts an action-required queue item for %s naming task, trigger, and evidence',
    trigger => {
      const outcome = service.post({
        chronicleRepo: '/chronicle',
        runId: 'run-1',
        entries: [entry(trigger)],
        evidenceIds: ['T-01-reviewer-transcript']
      });

      expect(outcome.posted).toHaveLength(1);
      expect(outcome.posted[0]).toBe(escalationTitle('run-1', entry(trigger)));
      const [, title, tags] = appendItem.mock.calls[0];
      expect(title).toContain('T-01');
      expect(title).toContain(trigger);
      expect(tags).toEqual(
        expect.arrayContaining([
          'action-required',
          `trigger:${trigger}`,
          'task:T-01',
          'evidence:runs://run-1/evidence/T-01-reviewer-transcript'
        ])
      );
    }
  );

  it('skips posting without a chronicle repo and is idempotent by title', () => {
    expect(
      service.post({
        runId: 'run-1',
        entries: [entry('envelope-breach')]
      }).posted
    ).toEqual([]);
    expect(appendItem).not.toHaveBeenCalled();

    appendItem.mockReturnValueOnce(true).mockReturnValueOnce(false);
    const first = service.post({
      chronicleRepo: '/chronicle',
      runId: 'run-1',
      entries: [entry('envelope-breach')]
    });
    const second = service.post({
      chronicleRepo: '/chronicle',
      runId: 'run-1',
      entries: [entry('envelope-breach')]
    });
    expect(first.posted).toHaveLength(1);
    expect(second.posted).toHaveLength(0);
  });

  it('files a needs-human issue keyed by run/task/trigger with the unblock command', () => {
    const outcome = service.post({
      repoPath: '/repo',
      runId: 'run-1',
      entries: [entry('envelope-breach')],
      evidenceIds: ['T-01-diff']
    });

    expect(outcome.issueUrls).toEqual(['https://github.com/o/r/issues/7']);
    const [call] = upsert.mock.calls;
    expect(call[0].key).toBe('run-1/T-01/envelope-breach');
    expect(call[0].labels).toEqual(
      expect.arrayContaining([
        NEEDS_HUMAN_LABEL,
        'sdlc-run:run-1',
        'trigger:envelope-breach',
        'task:T-01'
      ])
    );
    expect(call[0].body).toContain('envelope-breach detail');
    expect(call[0].body).toContain('allowedPaths');
    expect(call[0].body).toContain('Close this issue');
  });

  it('carries a task-specific remedy for manual-criterion stalls', () => {
    service.post({
      repoPath: '/repo',
      runId: 'run-1',
      entries: [entry('manual-criterion')]
    });

    expect(upsert.mock.calls[0][0].body).toContain('record-merge');
  });

  it('skips the issue surface without a repo path', () => {
    const outcome = service.post({
      chronicleRepo: '/chronicle',
      runId: 'run-1',
      entries: [entry('no-commit')]
    });

    expect(upsert).not.toHaveBeenCalled();
    expect(outcome.issueUrls).toEqual([]);
    expect(outcome.posted).toHaveLength(1);
  });

  it('keeps the queue item when GitHub is unreachable', () => {
    upsert.mockImplementation(() => {
      throw new Error('gh issue create failed');
    });

    const outcome = service.post({
      chronicleRepo: '/chronicle',
      repoPath: '/repo',
      runId: 'run-1',
      entries: [entry('agent-timeout')]
    });

    expect(outcome.posted).toHaveLength(1);
    expect(outcome.issueUrls).toEqual([]);
  });
});
