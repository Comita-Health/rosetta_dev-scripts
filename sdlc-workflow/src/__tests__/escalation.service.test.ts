import 'reflect-metadata';
import { Container } from 'inversify';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import type { IIssueRepository } from '../repositories/issue.repository';
import type { IQueueRepository } from '../repositories/queue.repository';
import {
  WakeInboxRepository,
  type IWakeInboxRepository
} from '../repositories/wake-inbox.repository';
import {
  EscalationService,
  IEscalationService,
  escalationTitle
} from '../services/escalation.service';
import { WorkflowError } from '../types';
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

describe('EscalationService (P3 T-06 + fail-loud T-04)', () => {
  let service: IEscalationService;
  let appendItem: jest.Mock;
  let findByTitle: jest.Mock;
  let createIssue: jest.Mock;
  let wakeRepo: IWakeInboxRepository;
  let wakeDir: string;
  let monitorPath: string;
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'escalate-'));
    wakeDir = path.join(tmpRoot, 'wake');
    monitorPath = path.join(tmpRoot, 'monitor.log');

    appendItem = jest.fn().mockReturnValue(true);
    findByTitle = jest.fn().mockReturnValue(null);
    createIssue = jest.fn().mockReturnValue({
      url: 'https://github.com/org/repo/issues/7',
      number: 7
    });

    const container = new Container();
    container
      .bind<IQueueRepository>(WORKFLOW_TOKENS.QueueRepository)
      .toConstantValue({ appendItem, itemTags: jest.fn() });
    container
      .bind<IIssueRepository>(WORKFLOW_TOKENS.IssueRepository)
      .toConstantValue({ findByTitle, create: createIssue });
    container
      .bind<IWakeInboxRepository>(WORKFLOW_TOKENS.WakeInboxRepository)
      .to(WakeInboxRepository);
    container
      .bind<IEscalationService>(WORKFLOW_TOKENS.EscalationService)
      .to(EscalationService);
    service = container.get(WORKFLOW_TOKENS.EscalationService);
    wakeRepo = container.get(WORKFLOW_TOKENS.WakeInboxRepository);
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
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
        evidenceIds: ['T-01-reviewer-transcript'],
        wakeDir
      });

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

  it('skips the queue without a chronicle repo but still wakes', () => {
    const outcome = service.post({
      runId: 'run-1',
      entries: [entry('envelope-breach')],
      wakeDir
    });
    expect(appendItem).not.toHaveBeenCalled();
    expect(createIssue).not.toHaveBeenCalled();
    expect(outcome.wakes).toHaveLength(1);
  });

  it('is idempotent by title for queue + wake across resume', () => {
    appendItem.mockReturnValueOnce(true).mockReturnValueOnce(false);
    const first = service.post({
      chronicleRepo: '/chronicle',
      runId: 'run-1',
      entries: [entry('envelope-breach')],
      wakeDir
    });
    const second = service.post({
      chronicleRepo: '/chronicle',
      runId: 'run-1',
      entries: [entry('envelope-breach')],
      wakeDir
    });
    expect(first.posted).toHaveLength(1);
    expect(first.wakes).toHaveLength(1);
    expect(second.wakes).toHaveLength(0);
    expect(second.posted).toHaveLength(0);
  });

  it('with an operator configured, posted needs-human issues include the assignee', () => {
    const outcome = service.post({
      chronicleRepo: '/chronicle',
      runId: 'run-1',
      repoPath: '/repo',
      operator: 'russwatson',
      entries: [entry('merge-blocked')],
      monitorPath,
      wakeDir
    });

    expect(createIssue).toHaveBeenCalledTimes(1);
    const [, input] = createIssue.mock.calls[0];
    expect(input.assignee).toBe('russwatson');
    expect(input.title).toBe(escalationTitle('run-1', entry('merge-blocked')));
    expect(outcome.issues[input.title]).toBe(
      'https://github.com/org/repo/issues/7'
    );
  });

  it('without an operator, issues still post and monitor.log warns about no assignee', () => {
    const outcome = service.post({
      chronicleRepo: '/chronicle',
      runId: 'run-1',
      repoPath: '/repo',
      entries: [entry('merge-blocked')],
      monitorPath,
      wakeDir
    });

    expect(createIssue).toHaveBeenCalledTimes(1);
    const [, input] = createIssue.mock.calls[0];
    expect(input.assignee).toBeUndefined();
    expect(outcome.posted.length).toBeGreaterThan(0);

    const monitor = readFileSync(monitorPath, 'utf8');
    expect(monitor).toContain('WARNING: no operator configured');
    expect(monitor).toContain('without assignee');
  });

  it('every escalation entry emits exactly one wake event (idempotent across resume)', () => {
    const entries = [
      entry('envelope-breach', 'T-01'),
      entry('merge-blocked', 'T-02')
    ];
    const first = service.post({
      chronicleRepo: '/chronicle',
      runId: 'run-1',
      repoPath: '/repo',
      operator: 'ops',
      entries,
      wakeDir
    });
    expect(first.wakes).toHaveLength(2);

    findByTitle.mockReturnValue({
      url: 'https://github.com/org/repo/issues/7',
      number: 7
    });
    appendItem.mockReturnValue(false);
    const second = service.post({
      chronicleRepo: '/chronicle',
      runId: 'run-1',
      repoPath: '/repo',
      operator: 'ops',
      entries,
      wakeDir
    });
    expect(second.wakes).toHaveLength(0);
    expect(createIssue).toHaveBeenCalledTimes(2);

    // Two pending wake files from the first call; resume did not add more.
    const pending = path.join(wakeDir, 'pending');
    const files = readdirSync(pending).filter(f => f.endsWith('.json'));
    expect(files).toHaveLength(2);
  });

  it('a failed GitHub issue post appends a visible monitor.log warning while the run continues', () => {
    // Real IssueRepository shape: the gh stderr lives in WorkflowError
    // details, not the message — the loud line must surface both.
    createIssue.mockImplementation(() => {
      throw new WorkflowError('gh issue failed', 'GH_FAILED', [
        'HTTP 403: Resource not accessible by integration'
      ]);
    });

    const outcome = service.post({
      chronicleRepo: '/chronicle',
      runId: 'run-1',
      repoPath: '/repo',
      operator: 'ops',
      entries: [entry('ci-fix-attempts-exhausted')],
      monitorPath,
      wakeDir
    });

    // Queue + wake still delivered; no throw.
    expect(appendItem).toHaveBeenCalled();
    expect(outcome.wakes).toHaveLength(1);
    expect(outcome.issues).toEqual({});

    const monitor = readFileSync(monitorPath, 'utf8');
    expect(monitor).toContain(
      'WARNING: failed to post needs-human GitHub issue'
    );
    expect(monitor).toContain('HTTP 403');
  });

  it('reuses an existing open issue by title instead of creating a duplicate', () => {
    findByTitle.mockReturnValue({
      url: 'https://github.com/org/repo/issues/3',
      number: 3
    });

    const outcome = service.post({
      runId: 'run-1',
      repoPath: '/repo',
      operator: 'ops',
      entries: [entry('budget-exhaustion')],
      wakeDir
    });

    expect(createIssue).not.toHaveBeenCalled();
    expect(
      outcome.issues[escalationTitle('run-1', entry('budget-exhaustion'))]
    ).toBe('https://github.com/org/repo/issues/3');
    expect(outcome.wakes).toHaveLength(1);
  });

  it('emitOnce on the wake repo itself is idempotent', () => {
    const a = wakeRepo.emitOnce({
      kind: 'sdlc_escalation',
      dedupeKey: 'k',
      prompt: 'p',
      wakeDir
    });
    const b = wakeRepo.emitOnce({
      kind: 'sdlc_escalation',
      dedupeKey: 'k',
      prompt: 'p',
      wakeDir
    });
    expect(a).not.toBeNull();
    expect(b).toBeNull();
  });
});
