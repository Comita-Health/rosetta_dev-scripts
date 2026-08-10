import 'reflect-metadata';
import { Container } from 'inversify';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import type { IIssueRepository } from '../repositories/issue.repository';
import type { IRunStateRepository } from '../repositories/run-state.repository';
import {
  AdvisoryIssueService,
  advisoryIssueBody,
  advisoryIssueTitle,
  IAdvisoryIssueService,
  isActionRequiredEscalationTitle,
  isAdvisoryIssueTitle
} from '../services/advisory-issue.service';
import { escalationWaveTitle } from '../services/escalation.service';
import {
  classifyOperatorUnstickOutcome,
  suppressesBlockingEscalate
} from '../services/operator-unstick.service';
import { WORKFLOW_TOKENS } from '../tokens';
import { RunState, WorkflowError } from '../types';

const makeState = (): RunState => ({
  runId: 'run-1',
  specId: 'SPEC-PRD-0025-P1',
  specPath: '/specs/spec.md',
  baseSha: 'base',
  taskResults: {},
  verdicts: [],
  exceptions: [],
  criterionVerdicts: [],
  steps: {},
  tokenSpendK: 0,
  ciFixAttempts: {},
  gateFixAttempts: {},
  operatorUnstickAttempts: {},
  operatorUnstickOutcomes: {},
  escalateTiers: {},
  remediations: {},
  mergeBlockedRetries: 0,
  updatedAt: 'x'
});

describe('AdvisoryIssueService (SPEC-PRD-0025-P1 T-04)', () => {
  let service: IAdvisoryIssueService;
  let findByTitle: jest.Mock;
  let createIssue: jest.Mock;
  let recordEscalateTier: jest.Mock;
  let recordExceptions: jest.Mock;
  let tmpRoot: string;
  let monitorPath: string;
  let state: RunState;

  beforeEach(() => {
    tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'advisory-'));
    monitorPath = path.join(tmpRoot, 'monitor.log');
    state = makeState();
    findByTitle = jest.fn().mockReturnValue(null);
    createIssue = jest.fn().mockReturnValue({
      url: 'https://github.com/org/repo/issues/42',
      number: 42
    });
    recordEscalateTier = jest.fn(
      (_runsDir: string, s: RunState, taskId: string, tier: string) => {
        s.escalateTiers = s.escalateTiers ?? {};
        s.escalateTiers[taskId] = tier as RunState['escalateTiers'][string];
      }
    );
    recordExceptions = jest.fn();

    const container = new Container();
    container
      .bind<IIssueRepository>(WORKFLOW_TOKENS.IssueRepository)
      .toConstantValue({ findByTitle, create: createIssue });
    container
      .bind<IRunStateRepository>(WORKFLOW_TOKENS.RunStateRepository)
      .toConstantValue({
        recordEscalateTier,
        recordExceptions,
        save: jest.fn(),
        load: jest.fn()
      } as unknown as IRunStateRepository);
    container
      .bind<IAdvisoryIssueService>(WORKFLOW_TOKENS.AdvisoryIssueService)
      .to(AdvisoryIssueService);
    service = container.get(WORKFLOW_TOKENS.AdvisoryIssueService);
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  describe('title / class distinct from ACTION REQUIRED', () => {
    it('uses ADVISORY title class distinct from escalationWaveTitle', () => {
      const advisory = advisoryIssueTitle('run-1', 'T-04');
      const blocking = escalationWaveTitle('run-1', 'T-04');
      expect(advisory).toBe('ADVISORY: SDLC run-1 T-04 risky proceed');
      expect(blocking).toBe('ACTION REQUIRED: SDLC run-1 T-04');
      expect(advisory).not.toBe(blocking);
      expect(isAdvisoryIssueTitle(advisory)).toBe(true);
      expect(isActionRequiredEscalationTitle(advisory)).toBe(false);
      expect(isActionRequiredEscalationTitle(blocking)).toBe(true);
      expect(isAdvisoryIssueTitle(blocking)).toBe(false);
    });
  });

  describe('body names decision, evidence, and course-correct steps', () => {
    it('includes decision, evidence links, and course-correct guidance', () => {
      const body = advisoryIssueBody(
        'run-1',
        'T-04',
        'force-pushed rebased tip over contested integration commit',
        'engine',
        ['T-04-reviewer-transcript', 'T-04-envelope-diff'],
        [
          'Inspect the contested tip on the blocker PR.',
          'Land a follow-up fix if the risky proceed was wrong.'
        ],
        {
          prUrl: 'https://github.com/org/repo/pull/7',
          branch: 'sdlc/run-1/T-04'
        }
      );

      expect(body).toContain('**Decision:** force-pushed rebased tip');
      expect(body).toContain('**Classified by:** engine');
      expect(body).toContain(
        '`runs://run-1/evidence/T-04-reviewer-transcript`'
      );
      expect(body).toContain('`runs://run-1/evidence/T-04-envelope-diff`');
      expect(body).toContain('### How to course-correct');
      expect(body).toContain('Inspect the contested tip on the blocker PR.');
      expect(body).toContain('https://github.com/org/repo/pull/7');
      expect(body).not.toMatch(/^ACTION REQUIRED:/m);
      expect(body).toContain('not an ACTION REQUIRED resume gate');
    });
  });

  describe('agent or engine risky classification → continue path', () => {
    it.each(['agent', 'engine'] as const)(
      'files advisory for %s-classified risky proceed without exception-ledger writes',
      classifiedBy => {
        const outcome = service.file({
          runId: 'run-1',
          taskId: 'T-04',
          decision: `${classifiedBy} classified strategy as risky-proceed`,
          classifiedBy,
          evidenceIds: ['T-04-reviewer-transcript'],
          repoPath: '/repo',
          operator: 'russwatson',
          monitorPath,
          runsDir: '/runs',
          state,
          refs: { prUrl: 'https://github.com/org/repo/pull/7' }
        });

        expect(outcome.title).toBe('ADVISORY: SDLC run-1 T-04 risky proceed');
        expect(outcome.created).toBe(true);
        expect(outcome.url).toBe('https://github.com/org/repo/issues/42');
        expect(createIssue).toHaveBeenCalledTimes(1);
        const [, input] = createIssue.mock.calls[0];
        expect(input.title).toBe(outcome.title);
        expect(input.title).not.toBe(escalationWaveTitle('run-1', 'T-04'));
        expect(input.body).toContain(`**Classified by:** ${classifiedBy}`);
        expect(input.body).toContain('**Decision:**');
        expect(input.body).toContain('### How to course-correct');
        expect(input.body).toContain(
          '`runs://run-1/evidence/T-04-reviewer-transcript`'
        );
        expect(input.assignee).toBe('russwatson');
        // Must not emit exception-ledger entries BlockerService would treat
        // as open needs-human blockers.
        expect(recordExceptions).not.toHaveBeenCalled();
      }
    );

    it('agent risky-proceed classification suppresses blocking escalate', () => {
      const kind = classifyOperatorUnstickOutcome({
        agentOutput: 'OUTCOME: risky-proceed — continuing with advisory',
        attempt: 1,
        attemptLimit: 2,
        taskMerged: false,
        headMoved: false,
        policyRewriteAttempt: false
      });
      expect(kind).toBe('risky-proceed');
      expect(suppressesBlockingEscalate(kind)).toBe(true);
    });

    it('engine-classified risky proceed uses the same continue semantics', () => {
      // Engine classification is modeled as a direct AdvisoryIssueService.file
      // call (handler/operator-unstick continue path) — never ACTION REQUIRED.
      const outcome = service.file({
        runId: 'run-1',
        taskId: 'T-04',
        decision: 'engine classified chosen strategy as risky',
        classifiedBy: 'engine',
        repoPath: '/repo',
        runsDir: '/runs',
        state
      });
      expect(isAdvisoryIssueTitle(outcome.title)).toBe(true);
      expect(isActionRequiredEscalationTitle(outcome.title)).toBe(false);
      expect(suppressesBlockingEscalate('risky-proceed')).toBe(true);
      expect(recordExceptions).not.toHaveBeenCalled();
    });
  });

  describe('escalate tier advisory-risky', () => {
    it('sets escalate tier to advisory-risky rather than halted-escalated', () => {
      service.file({
        runId: 'run-1',
        taskId: 'T-04',
        decision: 'risky proceed after contested tip',
        classifiedBy: 'agent',
        repoPath: '/repo',
        runsDir: '/runs',
        state
      });

      expect(recordEscalateTier).toHaveBeenCalledWith(
        '/runs',
        state,
        'T-04',
        'advisory-risky'
      );
      expect(state.escalateTiers['T-04']).toBe('advisory-risky');
      expect(state.escalateTiers['T-04']).not.toBe('halted-escalated');
    });

    it('still records advisory-risky when GitHub create is skipped', () => {
      const outcome = service.file({
        runId: 'run-1',
        taskId: 'T-04',
        decision: 'risky proceed — no repoPath',
        classifiedBy: 'engine',
        runsDir: '/runs',
        state
      });

      expect(outcome.created).toBe(false);
      expect(createIssue).not.toHaveBeenCalled();
      expect(recordEscalateTier).toHaveBeenCalledWith(
        '/runs',
        state,
        'T-04',
        'advisory-risky'
      );
    });
  });

  describe('idempotence and fail-soft GitHub', () => {
    it('reuses an existing open advisory issue by title', () => {
      findByTitle.mockReturnValue({
        url: 'https://github.com/org/repo/issues/9',
        number: 9
      });

      const outcome = service.file({
        runId: 'run-1',
        taskId: 'T-04',
        decision: 'risky proceed',
        classifiedBy: 'agent',
        repoPath: '/repo',
        runsDir: '/runs',
        state
      });

      expect(outcome.created).toBe(false);
      expect(outcome.url).toBe('https://github.com/org/repo/issues/9');
      expect(createIssue).not.toHaveBeenCalled();
      expect(recordEscalateTier).toHaveBeenCalled();
    });

    it('swallows gh failures with a loud monitor warning and still sets tier', () => {
      createIssue.mockImplementation(() => {
        throw new WorkflowError('gh issue failed', 'GH_FAILED', [
          'HTTP 403: Resource not accessible'
        ]);
      });

      const outcome = service.file({
        runId: 'run-1',
        taskId: 'T-04',
        decision: 'risky proceed',
        classifiedBy: 'agent',
        repoPath: '/repo',
        monitorPath,
        runsDir: '/runs',
        state
      });

      expect(outcome.created).toBe(false);
      expect(outcome.url).toBeUndefined();
      expect(state.escalateTiers['T-04']).toBe('advisory-risky');
      const log = readFileSync(monitorPath, 'utf-8');
      expect(log).toContain('[advisory] WARNING:');
      expect(log).toContain('ADVISORY: SDLC run-1 T-04 risky proceed');
      expect(log).toContain('Resource not accessible');
    });
  });
});
