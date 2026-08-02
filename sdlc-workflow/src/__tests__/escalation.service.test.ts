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

  // Every trigger must carry a next action. A trigger that falls through to
  // the generic remedy leaves the human in exactly the state the surface
  // exists to fix: told something is wrong, not told what to do.
  it.each([
    ['reviewer-disagreement', 'reviewer transcript'],
    ['envelope-breach', 'allowedPaths'],
    ['ci-fix-attempts-exhausted', 'three CI fixes'],
    ['budget-exhaustion', 'budgetK'],
    ['merge-blocked', 'Clear the red gate'],
    ['manual-criterion', 'record-merge'],
    ['no-commit', 'without committing anything'],
    ['agent-timeout', 'wall-clock budget'],
    ['pr-open-failed', 'GitHub App'],
    ['supervisor-died', 'supervise.log'],
    ['phase-blocked-on-unmerged', 'every task is merged']
  ] as const)('carries a %s-specific remedy', (trigger, expected) => {
    service.post({
      repoPath: '/repo',
      runId: 'run-1',
      entries: [entry(trigger)]
    });

    expect(upsert.mock.calls[0][0].body).toContain(expected);
  });

  it('falls back to a generic remedy for an unrecognized trigger', () => {
    service.post({
      repoPath: '/repo',
      runId: 'run-1',
      entries: [entry('something-new' as ExceptionEntry['trigger'])]
    });

    expect(upsert.mock.calls[0][0].body).toContain(
      'Resume once the blocker is cleared'
    );
  });

  it('does nothing at all when there are no entries', () => {
    const outcome = service.post({
      chronicleRepo: '/chronicle',
      repoPath: '/repo',
      runId: 'run-1',
      entries: []
    });

    expect(outcome).toEqual({ posted: [], issueUrls: [] });
    expect(appendItem).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
  });

  it('notes the absence of context rather than filing an empty issue', () => {
    service.post({
      repoPath: '/repo',
      runId: 'run-1',
      entries: [
        { trigger: 'no-commit', taskId: 'T-01', context: [], recordedAt: 'x' }
      ]
    });

    expect(upsert.mock.calls[0][0].body).toContain(
      'no additional context recorded'
    );
  });

  it('omits the task label for a run-level escalation', () => {
    service.post({
      repoPath: '/repo',
      runId: 'run-1',
      entries: [
        { trigger: 'supervisor-died', context: ['exited 1'], recordedAt: 'x' }
      ]
    });

    const { labels, body } = upsert.mock.calls[0][0];
    expect(labels).not.toContain('task:undefined');
    expect(body).toContain('run-level');
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
