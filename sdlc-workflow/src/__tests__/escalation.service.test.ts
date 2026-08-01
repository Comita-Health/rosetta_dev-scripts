import 'reflect-metadata';
import { Container } from 'inversify';
import type { IQueueRepository } from '../repositories/queue.repository';
import {
  EscalationService,
  IEscalationService,
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

  beforeEach(() => {
    appendItem = jest.fn().mockReturnValue(true);
    const container = new Container();
    container
      .bind<IQueueRepository>(WORKFLOW_TOKENS.QueueRepository)
      .toConstantValue({ appendItem, itemTags: jest.fn() });
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
});
