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

  it('links rich refs (PR, branch/head, spec, human-required, CI, sandbox) in the issue body, queue tags, and wake', () => {
    const prUrl = 'https://github.com/org/repo/pull/65';
    const refs = {
      prUrl,
      branch: 'sdlc/bug-run/T-01',
      headSha: 'abc123def456',
      specPath: '/workspace/specs/BUG-x/phase-1-spec.md',
      humanRequired: [
        'docs: README states where engine agent transcripts live'
      ],
      ciCheckUrls: [
        {
          name: 'test',
          url: 'https://github.com/org/repo/actions/runs/9'
        }
      ],
      sandbox: {
        sha: 'abc123def456',
        status: 'healthy' as const,
        evidenceId: 'T-01-sandbox-health'
      }
    };
    const outcome = service.post({
      chronicleRepo: '/chronicle',
      runId: 'bug-run',
      repoPath: '/repo',
      operator: 'russwatson',
      entries: [entry('merge-blocked')],
      evidenceIds: ['T-01-ci-monitor'],
      refs,
      monitorPath,
      wakeDir
    });

    expect(createIssue).toHaveBeenCalledTimes(1);
    const [, issueInput] = createIssue.mock.calls[0];
    expect(issueInput.body).toContain(`- **Blocker PR:** ${prUrl}`);
    expect(issueInput.body).toContain('- **Branch:** `sdlc/bug-run/T-01`');
    expect(issueInput.body).toContain('- **Head:** `abc123def456`');
    expect(issueInput.body).toContain(
      '- **Spec:** `/workspace/specs/BUG-x/phase-1-spec.md`'
    );
    expect(issueInput.body).toContain('### Human-required criteria');
    expect(issueInput.body).toContain(
      '- docs: README states where engine agent transcripts live'
    );
    expect(issueInput.body).toContain(
      '- [test](https://github.com/org/repo/actions/runs/9)'
    );
    expect(issueInput.body).toContain('### Sandbox');
    expect(issueInput.body).toContain(
      'runs://bug-run/evidence/T-01-sandbox-health'
    );
    expect(issueInput.body).toContain('merge-blocked detail');

    const [, , tags] = appendItem.mock.calls[0];
    expect(tags).toEqual(
      expect.arrayContaining([
        `pr:${prUrl}`,
        'branch:sdlc/bug-run/T-01',
        'head:abc123def456'
      ])
    );

    const title = escalationTitle('bug-run', entry('merge-blocked'));
    expect(outcome.wakes).toEqual([title]);
    const wakes = readdirSync(path.join(wakeDir, 'pending'));
    expect(wakes.length).toBe(1);
    const wake = JSON.parse(
      readFileSync(path.join(wakeDir, 'pending', wakes[0]), 'utf8')
    ) as { prompt: string; data: { refs?: { prUrl?: string } } };
    expect(wake.data.refs?.prUrl).toBe(prUrl);
    expect(wake.prompt).toContain(prUrl);
  });

  it('wake prompt falls back to branch when there is no blocker PR', () => {
    const outcome = service.post({
      runId: 'bug-run',
      entries: [entry('sandbox-failed')],
      refs: { branch: 'sdlc/bug-run/T-01', headSha: 'deadbeef' },
      wakeDir
    });

    const title = escalationTitle('bug-run', entry('sandbox-failed'));
    expect(outcome.wakes).toEqual([title]);
    const wakes = readdirSync(path.join(wakeDir, 'pending'));
    const wake = JSON.parse(
      readFileSync(path.join(wakeDir, 'pending', wakes[0]), 'utf8')
    ) as { prompt: string };
    expect(wake.prompt).toContain('Inspect branch sdlc/bug-run/T-01');
    expect(wake.prompt).not.toContain('Open the blocker PR');
  });

  it('issue body omits ref sections when refs are absent', () => {
    service.post({
      chronicleRepo: '/chronicle',
      runId: 'bug-run',
      repoPath: '/repo',
      entries: [entry('budget-exhaustion')],
      wakeDir
    });

    const [, issueInput] = createIssue.mock.calls[0];
    expect(issueInput.body).not.toContain('**Blocker PR:**');
    expect(issueInput.body).not.toContain('### Human-required criteria');
    expect(issueInput.body).toContain('### Context');
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

  // Wave 0: before this, a notified marker was never cleared and carried no
  // occurrence component, so an escalation title woke a human exactly once
  // ever — every recurrence against new content was silently swallowed.
  it('emitOnce re-notifies for a new occurrence key and stays quiet for a repeat', () => {
    const emit = (occurrenceKey: string): string | null =>
      wakeRepo.emitOnce({
        kind: 'sdlc_escalation',
        dedupeKey: 'k',
        prompt: 'p',
        occurrenceKey,
        wakeDir
      });

    expect(emit('sha-aaa')).not.toBeNull();
    expect(emit('sha-aaa')).toBeNull(); // a resume, not new evidence
    expect(emit('sha-bbb')).not.toBeNull(); // the fix pushed a new head
    expect(emit('sha-bbb')).toBeNull();

    // One pending file throughout: recurrence overwrites rather than
    // piling up N inbox entries for one problem.
    const files = readdirSync(path.join(wakeDir, 'pending')).filter(f =>
      f.endsWith('.json')
    );
    expect(files).toHaveLength(1);
  });

  it('keeps occurrence keys distinct even when the dedupe key fills the slug budget and the keys share a long prefix', () => {
    // Two length hazards at once: the title alone overflows the 96-char slug
    // cap (so the suffix must be reserved before truncation), and the two
    // occurrence keys differ only in their final character (so the suffix
    // cannot itself be a truncation).
    const longKey = `ACTION REQUIRED: SDLC ${'x'.repeat(80)} T-01 — reviewer-disagreement`;
    const emit = (occurrenceKey: string): string | null =>
      wakeRepo.emitOnce({
        kind: 'sdlc_escalation',
        dedupeKey: longKey,
        prompt: 'p',
        occurrenceKey,
        wakeDir
      });

    expect(emit('0000000000000000000000000000000000000001')).not.toBeNull();
    expect(emit('0000000000000000000000000000000000000002')).not.toBeNull();
  });

  // The engine passes `wakeDir` explicitly, but the daemon and hook scripts
  // read the same inbox through ROSETTA_WAKE_DIR — an emit that ignored the
  // env var would write somewhere nothing is watching.
  it('falls back to ROSETTA_WAKE_DIR when no wake directory is passed', () => {
    const envDir = path.join(tmpRoot, 'env-wake');
    const prior = process.env.ROSETTA_WAKE_DIR;
    process.env.ROSETTA_WAKE_DIR = envDir;
    try {
      const emitted = wakeRepo.emit({
        kind: 'sdlc_escalation',
        dedupeKey: 'env-k',
        prompt: 'p'
      });
      expect(emitted.startsWith(path.join(envDir, 'pending'))).toBe(true);

      const once = wakeRepo.emitOnce({
        kind: 'sdlc_escalation',
        dedupeKey: 'env-once',
        prompt: 'p'
      });
      expect(once).not.toBeNull();
      expect(
        wakeRepo.emitOnce({
          kind: 'sdlc_escalation',
          dedupeKey: 'env-once',
          prompt: 'p'
        })
      ).toBeNull();
    } finally {
      if (prior === undefined) delete process.env.ROSETTA_WAKE_DIR;
      else process.env.ROSETTA_WAKE_DIR = prior;
    }
  });

  it('escalation passes its occurrence key through to the wake marker', () => {
    const post = (occurrenceKey: string) =>
      service.post({
        runId: 'run-1',
        entries: [entry('reviewer-disagreement')],
        occurrenceKey,
        wakeDir
      });

    expect(post('head-1').wakes).toHaveLength(1);
    expect(post('head-1').wakes).toHaveLength(0);
    expect(post('head-2').wakes).toHaveLength(1);
  });
});
