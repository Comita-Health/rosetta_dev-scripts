import 'reflect-metadata';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import { Container } from 'inversify';
import { IRunHandler, RunHandler } from '../handlers/run.handler';
import type { IEvidenceRepository } from '../repositories/evidence.repository';
import type { IGitRepository } from '../repositories/git.repository';
import type { IQueueRepository } from '../repositories/queue.repository';
import {
  RunQueueRepository,
  type IRunQueueRepository
} from '../repositories/run-queue.repository';
import type { IRunStateRepository } from '../repositories/run-state.repository';
import type { ISpecDocRepository } from '../repositories/spec-doc.repository';
import type { IEscalationService } from '../services/escalation.service';
import type { IGateRemediationService } from '../services/gate-remediation.service';
import {
  RetryExecutorService,
  type IRetryExecutorService
} from '../services/retry-executor.service';
import type { IAggregatorService } from '../services/aggregator.service';
import type { IChronicleCommitService } from '../services/chronicle-commit.service';
import type { ICiGateService } from '../services/ci-gate.service';
import type { ICloseoutAggregateService } from '../services/closeout-aggregate.service';
import type { ICloseoutService } from '../services/closeout.service';
import type { IDigestService } from '../services/digest.service';
import type { IEnvelopeGateService } from '../services/envelope-gate.service';
import type { IRetroService } from '../services/retro.service';
import type { IPullRequestRepository } from '../repositories/pull-request.repository';
import type { IPrLifecycleService } from '../services/pr-lifecycle.service';
import type {
  ExecutorOutcome,
  IExecutorService,
  PoolOutcome
} from '../services/executor.service';
import type { IHeartbeatService } from '../services/heartbeat.service';
import type { IReviewerGateService } from '../services/reviewer-gate.service';
import type { IReviewerPublishService } from '../services/reviewer-publish.service';
import type { ISandboxDeployService } from '../services/sandbox-deploy.service';
import type {
  IVerificationService,
  VerificationInput
} from '../services/verification.service';
import { WORKFLOW_TOKENS } from '../tokens';
import {
  CloseoutAggregate,
  GateVerdict,
  RunState,
  SpecDocument,
  WorkflowError
} from '../types';
import { makeEnvelope, makeTask } from './fixtures';

const SPEC: SpecDocument = {
  id: 'SPEC-PRD-0099-P2',
  prdId: 'PRD-0099',
  phase: 2,
  status: 'Approved',
  envelope: makeEnvelope(),
  tasks: [makeTask()]
};

// BUG-* fixture (T-01): the id convention that gates the post-merge retro.
const BUG_SPEC: SpecDocument = {
  ...SPEC,
  id: 'SPEC-BUG-test-P1',
  prdId: 'BUG-test',
  context: 'Symptom: it broke. Repro: do the thing. Root cause: a gap.'
};

const makeState = (): RunState => ({
  runId: 'run-1',
  specId: SPEC.id,
  specPath: '/specs/spec.md',
  baseSha: 'base-sha',
  taskResults: {},
  verdicts: [],
  exceptions: [],
  criterionVerdicts: [],
  steps: {},
  tokenSpendK: 0,
  ciFixAttempts: {},
  gateFixAttempts: {},
  remediations: {},
  mergeBlockedRetries: 0,
  updatedAt: 'x'
});

const INPUT = {
  specPath: '/repo/specs/PRD-0099/phase-2-spec.md',
  repoPath: '/repo',
  runId: 'run-1',
  runsDir: '/runs',
  maxParallel: 3
};

/** Full gate order on a red envelope/reviewer — enforce skips sandbox there. */
const SHADOW_INPUT = { ...INPUT, shadow: true as const };

/** SPEC-PRD-0023-P1: the aggregation the closeout step is handed. */
const CLOSEOUT_AGGREGATE: CloseoutAggregate = {
  runId: 'run-1',
  specId: SPEC.id,
  criteria: [],
  taskGates: [],
  taskIds: ['T-01'],
  mergedTaskIds: ['T-01'],
  phasePassedTaskIds: ['T-01'],
  fullyCovered: true
};

const verdictOf = (
  gate: string,
  outcome: GateVerdict['outcome'],
  reasons: string[] = []
): GateVerdict => ({
  gate,
  outcome,
  wouldEscalate: outcome !== 'pass',
  reasons,
  recordedAt: 'x'
});

describe('RunHandler (shadow-mode pooled task loop)', () => {
  let handler: IRunHandler;
  let state: RunState;
  let executeReady: jest.Mock;
  let evaluate: jest.Mock;
  let review: jest.Mock;
  let deploy: jest.Mock;
  let verify: jest.Mock;
  let verifyTestTierOnly: jest.Mock;
  let ciEvaluate: jest.Mock;
  let aggregate: jest.Mock;
  let digestPost: jest.Mock;
  let retroPost: jest.Mock;
  let chronicleRecord: jest.Mock;
  let recordMerge: jest.Mock;
  let setContext: jest.Mock;
  let evidenceSave: jest.Mock;
  let appendVerdict: jest.Mock;
  let recordExceptions: jest.Mock;
  let recordSandbox: jest.Mock;
  let recordCriteria: jest.Mock;
  let recordStep: jest.Mock;
  let recordTaskPrUrl: jest.Mock;
  let stateLoad: jest.Mock;
  let openTaskPr: jest.Mock;
  let prMerge: jest.Mock;
  let mergeCommitOid: jest.Mock;
  let recordRevert: jest.Mock;
  let itemTags: jest.Mock;
  let revertMerge: jest.Mock;
  let prCreate: jest.Mock;
  let gitPush: jest.Mock;
  let gitFetch: jest.Mock;
  let treeSha: jest.Mock;
  let gitHeadSha: jest.Mock;
  let removeWorktreeAsync: jest.Mock;
  let specRead: jest.Mock;
  let escalationPost: jest.Mock;
  let remediate: jest.Mock;
  let closeoutAggregate: jest.Mock;
  let closeoutGenerate: jest.Mock;

  const taskOutcome = (
    overrides: Partial<ExecutorOutcome> = {}
  ): ExecutorOutcome => ({
    kind: 'completed',
    task: SPEC.tasks[0],
    branch: 'sdlc/run-1/T-01',
    cached: false,
    implDigest: 'impl-digest',
    baseSha: 'base-sha',
    ...overrides
  });

  const executedPool = (
    outcomes: ExecutorOutcome[] = [taskOutcome()]
  ): PoolOutcome => ({
    kind: 'executed',
    spec: SPEC,
    state,
    outcomes
  });

  let breachVerdict: GateVerdict;
  let reviewerVerdict: GateVerdict;
  let sandboxVerdict: GateVerdict;
  let verificationVerdict: GateVerdict;
  let ciVerdict: GateVerdict;
  let phaseVerdict: GateVerdict;
  const criterionVerdicts = [
    {
      taskId: 'T-01',
      criterion: 'test: it works',
      tier: 'test' as const,
      outcome: 'pass' as const,
      evidenceId: 'T-01-test-output',
      recordedAt: 'x'
    }
  ];

  beforeEach(() => {
    state = makeState();
    // The real executor records a task result before the handler pipeline.
    state.taskResults['T-01'] = {
      taskId: 'T-01',
      status: 'completed',
      branch: 'sdlc/run-1/T-01',
      recordedAt: 'x'
    };
    breachVerdict = verdictOf('envelope', 'breach', [
      'outside allowedPaths: infra/x.yml'
    ]);
    reviewerVerdict = verdictOf('reviewer', 'pass', ['looks solid']);
    sandboxVerdict = verdictOf('sandbox', 'pass', [
      'deployed and healthy at head-sha'
    ]);
    verificationVerdict = verdictOf('verification', 'pass');
    ciVerdict = verdictOf('ci', 'blocked', ['no CI results for head-sha']);
    phaseVerdict = verdictOf('phase', 'breach', [
      'failing gates: ci, envelope'
    ]);

    executeReady = jest.fn().mockImplementation(async () => executedPool());
    evaluate = jest.fn().mockResolvedValue(breachVerdict);
    review = jest.fn().mockResolvedValue(reviewerVerdict);
    deploy = jest.fn().mockResolvedValue({
      verdict: sandboxVerdict,
      record: { sha: 'head-sha', status: 'healthy', recordedAt: 'x' },
      healthReport: 'sha=head-sha ok'
    });
    verify = jest.fn().mockResolvedValue({
      verdict: verificationVerdict,
      criteria: criterionVerdicts
    });
    // Returning undefined mirrors "not precomputed" so verify() above runs
    // its own test-tier path unaffected in tests that don't care about it.
    verifyTestTierOnly = jest.fn().mockResolvedValue(undefined);
    ciEvaluate = jest.fn().mockResolvedValue(ciVerdict);
    aggregate = jest.fn().mockReturnValue({
      verdict: phaseVerdict,
      exceptions: [
        {
          trigger: 'envelope-breach',
          taskId: 'T-01',
          context: ['outside allowedPaths: infra/x.yml'],
          recordedAt: 'x'
        }
      ]
    });
    digestPost = jest.fn().mockResolvedValue({
      digest: { schema: 'sdlc.digest.v1' },
      artifactPath: 'chronicles/sdlc/run-1/digest-T-01.json',
      queueAppended: true
    });
    retroPost = jest.fn().mockResolvedValue({
      retro: { schema: 'sdlc.retro.v1' },
      artifactPath: 'chronicles/sdlc/run-1/retro.json',
      queueAppended: true
    });
    chronicleRecord = jest.fn().mockResolvedValue({ artifactPaths: ['a'] });
    recordMerge = jest
      .fn()
      .mockResolvedValue('chronicles/sdlc/run-1/merge.json');
    setContext = jest.fn();
    evidenceSave = jest.fn().mockReturnValue('/evidence/x.txt');
    closeoutAggregate = jest.fn().mockReturnValue(CLOSEOUT_AGGREGATE);
    closeoutGenerate = jest.fn().mockResolvedValue({
      kind: 'created',
      pr: { url: 'https://github.com/o/r/pull/9', number: 9 },
      statusWritten: 'Done',
      tickedCount: 1,
      remainderCount: 0
    });

    // Persistence mocks mirror the real repository's in-memory mutation so
    // resume behaviour (step cache, verdict filtering) can be exercised.
    appendVerdict = jest.fn().mockImplementation((_d, s: RunState, verdict) => {
      s.verdicts.push(verdict);
    });
    recordExceptions = jest
      .fn()
      .mockImplementation((_d, s: RunState, entries) => {
        s.exceptions.push(...entries);
      });
    recordSandbox = jest.fn().mockImplementation((_d, s: RunState, record) => {
      s.sandbox = record;
    });
    recordCriteria = jest.fn();
    recordStep = jest.fn().mockImplementation((_d, s: RunState, key, step) => {
      s.steps[key] = step;
    });
    recordTaskPrUrl = jest
      .fn()
      .mockImplementation((_d, s: RunState, taskId: string, url: string) => {
        if (s.taskResults[taskId] !== undefined) {
          s.taskResults[taskId].prUrl = url;
        }
      });
    stateLoad = jest.fn();
    openTaskPr = jest.fn().mockReturnValue({
      url: 'https://github.com/org/repo/pull/7',
      number: 7,
      created: true
    });
    prMerge = jest.fn().mockReturnValue('merged-sha-abc');
    mergeCommitOid = jest.fn().mockReturnValue(null);
    recordRevert = jest.fn().mockResolvedValue('chronicles/sdlc/run-1/revert');
    itemTags = jest.fn().mockReturnValue(null);
    revertMerge = jest.fn();
    gitPush = jest.fn();
    gitFetch = jest.fn();
    treeSha = jest.fn().mockReturnValue('tree-sha');
    gitHeadSha = jest.fn().mockReturnValue('head-sha');
    removeWorktreeAsync = jest.fn();
    prCreate = jest.fn().mockReturnValue({
      url: 'https://github.com/org/repo/pull/99',
      number: 99
    });
    specRead = jest.fn().mockReturnValue(SPEC);
    escalationPost = jest
      .fn()
      .mockReturnValue({ posted: [], wakes: [], issues: {} });
    // Default: nothing to remediate, so red gates still escalate and block
    // exactly as they did before Wave 0 — tests that want the remediation
    // path override this per case.
    remediate = jest.fn().mockResolvedValue({
      kind: 'skipped',
      attempt: 0,
      detail: 'no remediable gate findings'
    });

    const container = new Container();
    container
      .bind<IExecutorService>(WORKFLOW_TOKENS.ExecutorService)
      .toConstantValue({ executeReady });
    container
      .bind<IEnvelopeGateService>(WORKFLOW_TOKENS.EnvelopeGateService)
      .toConstantValue({ evaluate });
    container
      .bind<IReviewerGateService>(WORKFLOW_TOKENS.ReviewerGateService)
      .toConstantValue({ review });
    container
      .bind<IReviewerPublishService>(WORKFLOW_TOKENS.ReviewerPublishService)
      .toConstantValue({
        markPending: jest.fn(),
        publishResult: jest.fn()
      });
    container
      .bind<IPrLifecycleService>(WORKFLOW_TOKENS.PrLifecycleService)
      .toConstantValue({ openTaskPr });
    container
      .bind<IPullRequestRepository>(WORKFLOW_TOKENS.PullRequestRepository)
      .toConstantValue({
        findByBranch: jest.fn().mockReturnValue(null),
        create: prCreate,
        merge: prMerge,
        mergeCommitOid,
        comment: jest.fn(),
        latestForBranch: jest.fn().mockReturnValue(null),
        updateBody: jest.fn()
      });
    container
      .bind<IQueueRepository>(WORKFLOW_TOKENS.QueueRepository)
      .toConstantValue({ appendItem: jest.fn(), itemTags });
    container
      .bind<IRunQueueRepository>(WORKFLOW_TOKENS.RunQueueRepository)
      .to(RunQueueRepository);
    container
      .bind<IEscalationService>(WORKFLOW_TOKENS.EscalationService)
      .toConstantValue({ post: escalationPost });
    container
      .bind<ISpecDocRepository>(WORKFLOW_TOKENS.SpecDocRepository)
      .toConstantValue({
        read: specRead,
        readAtRef: jest.fn().mockImplementation(() => specRead())
      });
    container
      .bind<ISandboxDeployService>(WORKFLOW_TOKENS.SandboxDeployService)
      .toConstantValue({ deploy });
    container
      .bind<IVerificationService>(WORKFLOW_TOKENS.VerificationService)
      .toConstantValue({ verify, verifyTestTierOnly });
    container
      .bind<ICiGateService>(WORKFLOW_TOKENS.CiGateService)
      .toConstantValue({ monitor: ciEvaluate });
    container
      .bind<IAggregatorService>(WORKFLOW_TOKENS.AggregatorService)
      .toConstantValue({ aggregate });
    container
      .bind<IDigestService>(WORKFLOW_TOKENS.DigestService)
      .toConstantValue({ post: digestPost });
    container
      .bind<IRetroService>(WORKFLOW_TOKENS.RetroService)
      .toConstantValue({ post: retroPost });
    container
      .bind<IChronicleCommitService>(WORKFLOW_TOKENS.ChronicleCommitService)
      .toConstantValue({ record: chronicleRecord, recordMerge, recordRevert });
    container
      .bind<IEvidenceRepository>(WORKFLOW_TOKENS.EvidenceRepository)
      .toConstantValue({ save: evidenceSave, load: jest.fn() });
    container
      .bind<IGitRepository>(WORKFLOW_TOKENS.GitRepository)
      .toConstantValue({
        headSha: gitHeadSha,
        status: jest.fn(),
        addWorktree: jest.fn(),
        diffStat: jest.fn(),
        diffText: jest.fn(),
        push: gitPush,
        fetch: gitFetch,
        resolveSha: jest.fn().mockReturnValue('main-sha'),
        treeSha,
        worktreeForBranch: jest.fn(),
        refExists: jest.fn().mockReturnValue(false),
        defaultBranch: jest.fn().mockReturnValue('main'),
        fileAtRef: jest.fn(),
        pathDiffersFromRef: jest.fn(),
        revertMerge,
        stageAll: jest.fn(),
        commit: jest.fn(),
        listFiles: jest.fn().mockReturnValue([]),
        removeWorktreeAsync
      });
    container
      .bind<IHeartbeatService>(WORKFLOW_TOKENS.HeartbeatService)
      .toConstantValue({
        start: jest.fn(),
        setContext,
        tick: jest.fn(),
        stop: jest.fn()
      });
    container
      .bind<IRunStateRepository>(WORKFLOW_TOKENS.RunStateRepository)
      .toConstantValue({
        appendVerdict,
        recordExceptions,
        recordSandbox,
        recordCriteria,
        recordStep,
        recordMergedSha: jest
          .fn()
          .mockImplementation((_d, s: RunState, sha: string) => {
            s.mergedSha = sha;
          }),
        recordTaskMerged: jest
          .fn()
          .mockImplementation(
            (_d, s: RunState, taskId: string, sha: string) => {
              if (s.taskResults[taskId] !== undefined) {
                s.taskResults[taskId].mergedSha = sha;
              }
            }
          ),
        recordTaskPrUrl,
        recordCiFixAttempt: jest.fn(),
        recordTokenSpend: jest.fn(),
        recordGateFixAttempt: jest.fn(),
        recordRemediation: jest.fn(),
        recordMergeBlockedRetry: jest.fn(),
        invalidateSteps: jest.fn().mockReturnValue([]),
        load: stateLoad,
        save: jest.fn(),
        recordTaskResult: jest.fn()
      });
    container
      .bind<IGateRemediationService>(WORKFLOW_TOKENS.GateRemediationService)
      .toConstantValue({ remediate });
    container
      .bind<ICloseoutAggregateService>(WORKFLOW_TOKENS.CloseoutAggregateService)
      .toConstantValue({ aggregate: closeoutAggregate });
    container
      .bind<ICloseoutService>(WORKFLOW_TOKENS.CloseoutService)
      .toConstantValue({ generate: closeoutGenerate });
    // The real executor: retry policy is behavior under test here, not a
    // collaborator to stub out. Backoff is zeroed per call via input.
    container
      .bind<IRetryExecutorService>(WORKFLOW_TOKENS.RetryExecutorService)
      .to(RetryExecutorService);
    container.bind<IRunHandler>(WORKFLOW_TOKENS.RunHandler).to(RunHandler);
    handler = container.get<IRunHandler>(WORKFLOW_TOKENS.RunHandler);
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    (console.log as jest.Mock).mockRestore();
  });

  it('persists all gate verdicts and exceptions, proceeding unblocked on breaches', async () => {
    const result = await handler.runTask(SHADOW_INPUT);

    // Shadow semantics: breaches are recorded, the run is not failed by them.
    expect(result).toEqual({
      outcome: 'executed',
      tasks: [{ taskId: 'T-01', kind: 'completed', branch: 'sdlc/run-1/T-01' }]
    });
    // envelope, reviewer, sandbox, verification, ci, phase
    expect(appendVerdict).toHaveBeenCalledTimes(6);
    for (const verdict of [
      breachVerdict,
      reviewerVerdict,
      sandboxVerdict,
      verificationVerdict,
      ciVerdict,
      phaseVerdict
    ]) {
      expect(appendVerdict).toHaveBeenCalledWith(
        '/runs',
        expect.anything(),
        verdict
      );
      // T-08: every recorded verdict carries task identity and inputs digest.
      expect(verdict.taskId).toBe('T-01');
      expect(verdict.inputsDigest).toEqual(expect.any(String));
    }
    expect(recordSandbox).toHaveBeenCalledWith(
      '/runs',
      expect.anything(),
      expect.objectContaining({ sha: 'head-sha', status: 'healthy' })
    );
    expect(recordCriteria).toHaveBeenCalledWith(
      '/runs',
      expect.anything(),
      criterionVerdicts
    );
    expect(recordExceptions).toHaveBeenCalledWith(
      '/runs',
      expect.anything(),
      expect.arrayContaining([
        expect.objectContaining({ trigger: 'envelope-breach' })
      ])
    );
  });

  it('deploys the task branch head to the sandbox and hands the health report to verification', async () => {
    await handler.runTask(SHADOW_INPUT);

    expect(deploy).toHaveBeenCalledWith({
      worktreePath: '/runs/run-1/worktrees/T-01',
      sha: 'head-sha',
      // SPEC-PRD-0011-P4 T-01: the deploy scope is the task's integration tip,
      // the same base the envelope and reviewer gates diff against.
      baseSha: 'base-sha',
      previous: undefined,
      // SPEC-PRD-0022-P1 T-01: the tree the commit points at is the dedup key.
      ledger: {
        runsDir: '/runs',
        runId: 'run-1',
        contentSha: 'tree-sha',
        trigger: 'task',
        taskId: 'T-01'
      }
    });
    expect(verify).toHaveBeenCalledWith(
      expect.objectContaining({
        worktreePath: '/runs/run-1/worktrees/T-01',
        task: SPEC.tasks[0],
        healthReport: 'sha=head-sha ok'
      })
    );
    // Sandbox health is attached as resolvable evidence (T-08).
    expect(evidenceSave).toHaveBeenCalledWith(
      '/runs',
      'run-1',
      'T-01-sandbox-health',
      'sha=head-sha ok'
    );
  });

  it('disables deploy dedup for a dispatch whose tree it cannot resolve', async () => {
    // A missing content key costs a possibly redundant deploy. Failing the run
    // instead would trade that for no delivery at all.
    treeSha.mockImplementation(() => {
      throw new Error('fatal: not a tree object');
    });

    await handler.runTask(SHADOW_INPUT);

    expect(deploy).toHaveBeenCalledWith(
      expect.objectContaining({ ledger: undefined })
    );
  });

  it('records a blocked verification verdict when criterion validation fails, without crashing the run', async () => {
    verify.mockRejectedValue(
      new WorkflowError('bad criterion prefix', 'SPEC_MALFORMED')
    );

    const result = await handler.runTask(SHADOW_INPUT);

    expect(result.outcome).toBe('executed');
    const call = aggregate.mock.calls[0][0];
    expect(call.gates.verification.outcome).toBe('blocked');
    expect(call.gates.verification.reasons).toEqual(['bad criterion prefix']);
    expect(recordCriteria).toHaveBeenCalledWith('/runs', expect.anything(), []);
  });

  it('rethrows unexpected verification errors', async () => {
    verify.mockRejectedValue(new Error('disk on fire'));

    await expect(handler.runTask(SHADOW_INPUT)).rejects.toThrow('disk on fire');
  });

  it('feeds real envelope/reviewer/verification/ci verdicts to the aggregator', async () => {
    await handler.runTask(SHADOW_INPUT);

    expect(ciEvaluate).toHaveBeenCalledWith(
      expect.objectContaining({
        repoPath: '/repo',
        worktreePath: '/runs/run-1/worktrees/T-01',
        branch: 'sdlc/run-1/T-01',
        sha: 'head-sha',
        task: SPEC.tasks[0],
        runsDir: '/runs'
      })
    );
    const call = aggregate.mock.calls[0][0];
    expect(call.gates.envelope).toBe(breachVerdict);
    expect(call.gates.reviewer).toBe(reviewerVerdict);
    expect(call.gates.verification).toBe(verificationVerdict);
    expect(call.gates.ci).toBe(ciVerdict);
    expect(call.taskId).toBe('T-01');
    expect(call.budgetK).toBe(SPEC.envelope.budgetK);
  });

  it('saves the reviewer transcript as resolvable evidence', async () => {
    review.mockResolvedValue({
      ...verdictOf('reviewer', 'breach', ['disagree']),
      transcript: 'full reviewer transcript'
    });

    await handler.runTask(INPUT);

    expect(evidenceSave).toHaveBeenCalledWith(
      '/runs',
      'run-1',
      'T-01-reviewer-transcript',
      'full reviewer transcript'
    );
  });

  it('halts at intake for a blocked run without evaluating gates', async () => {
    executeReady.mockResolvedValue({
      kind: 'blocked',
      spec: SPEC,
      state,
      detail: 'unapproved-spec',
      outcomes: []
    });

    const result = await handler.runTask(INPUT);

    expect(result.outcome).toBe('blocked');
    expect(evaluate).not.toHaveBeenCalled();
    expect(review).not.toHaveBeenCalled();
    expect(appendVerdict).not.toHaveBeenCalled();
  });

  it('prints pool.detail and intake reasons when intake is blocked', async () => {
    const blockedState = {
      ...state,
      verdicts: [
        {
          gate: 'intake' as const,
          outcome: 'blocked' as const,
          wouldEscalate: true,
          reasons: [
            'spec-not-merged',
            'specs/x.md does not exist on origin/main — approve and merge the spec PR first'
          ],
          recordedAt: 'x'
        }
      ]
    };
    executeReady.mockResolvedValue({
      kind: 'blocked',
      spec: SPEC,
      state: blockedState,
      detail: 'spec-not-merged',
      outcomes: []
    });

    await handler.runTask(INPUT);

    const printed = (console.log as jest.Mock).mock.calls
      .map(c => String(c[0]))
      .join('\n');
    expect(printed).toContain('spec-not-merged');
    expect(printed).toContain('does not exist on origin/main');
    expect(printed).not.toContain('unapproved-spec');
  });

  it('reports no-ready-task without gate evaluation', async () => {
    executeReady.mockResolvedValue({
      kind: 'no-ready-task',
      spec: SPEC,
      state: null,
      outcomes: []
    });

    const result = await handler.runTask(INPUT);

    expect(result.outcome).toBe('no-ready-task');
    expect(evaluate).not.toHaveBeenCalled();
  });

  it('throws on an executed pool without state (contract violation)', async () => {
    executeReady.mockResolvedValue({
      kind: 'executed',
      spec: SPEC,
      state: null,
      outcomes: [taskOutcome()]
    });

    await expect(handler.runTask(INPUT)).rejects.toThrow(
      'executor returned an executed pool without state'
    );
  });

  it('skips the gate pipeline for a failed task, reporting the failure (P3 T-01)', async () => {
    executeReady.mockImplementation(async () =>
      executedPool([taskOutcome({ kind: 'failed', detail: 'agent exploded' })])
    );

    const result = await handler.runTask(INPUT);

    expect(result.tasks).toEqual([
      { taskId: 'T-01', kind: 'failed', branch: 'sdlc/run-1/T-01' }
    ]);
    expect(evaluate).not.toHaveBeenCalled();
    expect(review).not.toHaveBeenCalled();
    expect(deploy).not.toHaveBeenCalled();
  });

  it('pipelines every completed task of a pooled wave (P3 T-01)', async () => {
    const taskB = makeTask({ id: 'T-02' });
    executeReady.mockImplementation(async () =>
      executedPool([
        taskOutcome(),
        taskOutcome({ task: taskB, branch: 'sdlc/run-1/T-02' })
      ])
    );

    const result = await handler.runTask(SHADOW_INPUT);

    expect(result.tasks.map(task => task.taskId)).toEqual(['T-01', 'T-02']);
    // Each completed task goes through the full gate pipeline.
    expect(evaluate).toHaveBeenCalledTimes(2);
    expect(review).toHaveBeenCalledTimes(2);
    expect(deploy).toHaveBeenCalledTimes(2);
    expect(verify).toHaveBeenCalledTimes(2);
    expect(ciEvaluate).toHaveBeenCalledTimes(2);
    expect(aggregate).toHaveBeenCalledTimes(2);
    // 6 verdicts per task.
    expect(appendVerdict).toHaveBeenCalledTimes(12);
  });

  it('envelope and reviewer diff against the task integration tip, not frozen base (#42 F1)', async () => {
    executeReady.mockImplementation(async () =>
      executedPool([
        taskOutcome({
          task: makeTask({ id: 'T-04', dependsOn: ['T-01'] }),
          branch: 'sdlc/run-1/T-04',
          baseSha: 'integration-tip'
        })
      ])
    );
    state.taskResults['T-04'] = {
      taskId: 'T-04',
      status: 'completed',
      branch: 'sdlc/run-1/T-04',
      recordedAt: 'x'
    };

    await handler.runTask(INPUT);

    expect(evaluate).toHaveBeenCalledWith(
      expect.objectContaining({
        baseRef: 'integration-tip',
        headRef: 'sdlc/run-1/T-04'
      })
    );
    expect(review).toHaveBeenCalledWith(
      expect.objectContaining({
        baseRef: 'integration-tip',
        headRef: 'sdlc/run-1/T-04'
      })
    );
    expect(evaluate).not.toHaveBeenCalledWith(
      expect.objectContaining({ baseRef: 'base-sha' })
    );
  });

  it('pushes the task branch and opens its PR before the gates, recording the URL (P3 T-02)', async () => {
    await handler.runTask(INPUT);

    expect(openTaskPr).toHaveBeenCalledWith({
      worktreePath: '/runs/run-1/worktrees/T-01',
      branch: 'sdlc/run-1/T-01',
      runId: 'run-1',
      spec: SPEC,
      task: SPEC.tasks[0],
      verdicts: []
    });
    // The PR exists before any gate is evaluated (it is their subject).
    expect(openTaskPr.mock.invocationCallOrder[0]).toBeLessThan(
      evaluate.mock.invocationCallOrder[0]
    );
    expect(recordTaskPrUrl).toHaveBeenCalledWith(
      '/runs',
      expect.anything(),
      'T-01',
      'https://github.com/org/repo/pull/7'
    );
    expect(recordStep).toHaveBeenCalledWith(
      '/runs',
      expect.anything(),
      expect.stringMatching(/^pr:T-01:/),
      expect.objectContaining({
        name: 'pr',
        detail: 'https://github.com/org/repo/pull/7'
      })
    );
  });

  it('resume reuses the recorded PR without reopening it (P3 T-02)', async () => {
    await handler.runTask(INPUT);
    await handler.runTask(INPUT);

    expect(openTaskPr).toHaveBeenCalledTimes(1);
  });

  // SPEC-PRD-0021-P1 T-04: a transient PR-open failure used to cost the whole
  // task — it recorded a blocked verdict and waited for a hand relaunch. Now
  // the shared retry executor absorbs it in-process.
  it('recovers from a transient push/PR failure without blocking the task', async () => {
    openTaskPr.mockImplementationOnce(() => {
      throw new WorkflowError('gh pr failed', 'GH_FAILED', ['boom']);
    });

    const result = await handler.runTask({ ...INPUT, retryBackoffMs: 0 });

    expect(result.outcome).toBe('executed');
    expect(openTaskPr).toHaveBeenCalledTimes(2);
    expect(state.verdicts).not.toContainEqual(
      expect.objectContaining({ gate: 'pr', outcome: 'blocked' })
    );
    expect(recordTaskPrUrl).toHaveBeenCalledTimes(1);

    // The attempt trail survives on the step, so a flaky step is visible
    // afterwards rather than only in a log the operator no longer has.
    const prStep = Object.entries(state.steps).find(([key]) =>
      key.startsWith('pr:')
    )?.[1];
    expect(prStep?.recovery).toMatchObject({
      path: 'pr:T-01',
      escalated: false
    });
    expect(prStep?.recovery?.attempts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ attempt: 1, outcome: 'failed' }),
        expect.objectContaining({ attempt: 2, outcome: 'succeeded' })
      ])
    );
  });

  it('does not stamp a recovery record on a step that succeeded first try', async () => {
    await handler.runTask(INPUT);

    const prStep = Object.entries(state.steps).find(([key]) =>
      key.startsWith('pr:')
    )?.[1];
    // Presence of the record is the "this was flaky" signal — a history on
    // every step would erase it.
    expect(prStep?.recovery).toBeUndefined();
  });

  it('records a blocked pr verdict once retries are exhausted, keeping state intact for the next run (P3 T-02)', async () => {
    openTaskPr.mockImplementation(() => {
      throw new WorkflowError('gh pr failed', 'GH_FAILED', ['boom']);
    });

    const result = await handler.runTask({ ...INPUT, retryBackoffMs: 0 });

    // The failure is recorded honestly and the pipeline continues.
    expect(result.outcome).toBe('executed');
    expect(state.verdicts).toContainEqual(
      expect.objectContaining({
        gate: 'pr',
        outcome: 'blocked',
        taskId: 'T-01',
        reasons: [expect.stringContaining('boom')]
      })
    );
    expect(recordTaskPrUrl).not.toHaveBeenCalled();
    // No 'pr' step was cached, so the next invocation retries.
    expect(Object.keys(state.steps).some(key => key.startsWith('pr:'))).toBe(
      false
    );
    expect(evaluate).toHaveBeenCalledTimes(1); // gates still ran
  });

  describe('P3 T-04 gate enforcement', () => {
    const greenGates = () => {
      evaluate.mockResolvedValue(verdictOf('envelope', 'pass'));
      review.mockResolvedValue(verdictOf('reviewer', 'pass'));
      verify.mockResolvedValue({
        verdict: verdictOf('verification', 'pass'),
        criteria: criterionVerdicts
      });
      ciEvaluate.mockResolvedValue(verdictOf('ci', 'pass'));
      aggregate.mockReturnValue({
        verdict: verdictOf('phase', 'pass'),
        exceptions: []
      });
    };

    it('dispatches the sandbox deploy and test-tier verification concurrently, not sequentially', async () => {
      greenGates();
      let resolveDeploy: (value: unknown) => void = () => {};
      deploy.mockReturnValue(
        new Promise(resolve => {
          resolveDeploy = resolve;
        })
      );

      const runPromise = handler.runTask(INPUT);

      // Flush pending microtasks (envelope + reviewer each chain several
      // awaits before reaching the sandbox/verification dispatch) without
      // resolving the deploy promise — if verifyTestTierOnly were only
      // dispatched after sandbox resolved, it would not have been called
      // yet at this point.
      for (let i = 0; i < 20; i++) {
        await Promise.resolve();
      }
      expect(verifyTestTierOnly).toHaveBeenCalled();
      expect(verify).not.toHaveBeenCalled();

      resolveDeploy({
        verdict: verdictOf('sandbox', 'pass'),
        healthReport: 'sha=head-sha ok'
      });
      await runPromise;

      expect(verify).toHaveBeenCalled();
    });

    it('auto-merges the PR when all four gates are green, recording the SHA in state and Chronicle', async () => {
      greenGates();

      await handler.runTask({ ...INPUT, chronicleRepo: '/chronicle' });

      expect(prMerge).toHaveBeenCalledWith('/repo', 7);
      expect(gitFetch).toHaveBeenCalledWith('/repo');
      expect(state.taskResults['T-01'].mergedSha).toBe('merged-sha-abc');
      expect(state.mergedSha).toBe('merged-sha-abc');
      // sdlc.merge.v1 artifact, attributed to the machine gates.
      expect(recordMerge).toHaveBeenCalledWith(
        expect.objectContaining({
          mergedSha: 'merged-sha-abc',
          taskId: 'T-01',
          approvedBy: 'machine-gates'
        })
      );
      // Cached: resume does not merge twice.
      await handler.runTask({ ...INPUT, chronicleRepo: '/chronicle' });
      expect(prMerge).toHaveBeenCalledTimes(1);
    });

    it.each(['envelope', 'reviewer', 'verification', 'ci'] as const)(
      'a red %s gate blocks the merge and records the escalation — no merge call',
      async gate => {
        greenGates();
        const red = verdictOf(gate, 'breach', [`${gate} went red`]);
        if (gate === 'envelope') evaluate.mockResolvedValue(red);
        if (gate === 'reviewer') review.mockResolvedValue(red);
        if (gate === 'verification')
          verify.mockResolvedValue({ verdict: red, criteria: [] });
        if (gate === 'ci') ciEvaluate.mockResolvedValue(red);
        aggregate.mockReturnValue({
          verdict: verdictOf('phase', 'breach', [`failing gates: ${gate}`]),
          exceptions: []
        });

        await handler.runTask(INPUT);

        expect(prMerge).not.toHaveBeenCalled();
        expect(recordMerge).not.toHaveBeenCalled();
        expect(state.exceptions).toContainEqual(
          expect.objectContaining({
            trigger: 'merge-blocked',
            taskId: 'T-01',
            context: [`failing gates: ${gate}`]
          })
        );
      }
    );

    // Wave 0 instrumentation: 52.6% of measured work was unobservable because
    // only `starting`, `implementation` and `reviewer` set a heartbeat step —
    // sandbox, verification, ci and merge time all accrued under whatever
    // label was left over, which overstated reviewer time by ~3.5 min a
    // segment.
    it('labels every post-implementation step so time is not misattributed to reviewer', async () => {
      greenGates();

      await handler.runTask(INPUT);

      const steps = setContext.mock.calls.map(([ctx]) => ctx.step);
      expect(steps).toEqual(
        expect.arrayContaining([
          'reviewer',
          'sandbox',
          'verification',
          'ci',
          'merge'
        ])
      );
      // The reviewer label must be superseded, not left standing over the
      // gates that follow it.
      expect(steps.lastIndexOf('reviewer')).toBeLessThan(
        steps.lastIndexOf('merge')
      );
    });

    it('labels the verifier agent as verification while it runs', async () => {
      greenGates();
      // The real service calls the sink per agent-tier criterion; the mock
      // stands in for that contract.
      verify.mockImplementation(async (verifyInput: VerificationInput) => {
        verifyInput.progress?.set({
          taskId: 'T-01',
          step: 'verification',
          lastLine: 'verifier agent 1/1: the thing works'
        });
        return {
          verdict: verdictOf('verification', 'pass'),
          criteria: criterionVerdicts
        };
      });

      await handler.runTask(INPUT);

      expect(setContext).toHaveBeenCalledWith(
        expect.objectContaining({
          step: 'verification',
          lastLine: 'verifier agent 1/1: the thing works'
        })
      );
    });

    // Wave 0: a red *remediable* gate gets one bounded agent round before it
    // becomes a needs-human escalation. Reviewer disagreement and envelope
    // breach were 22 of 44 historical escalations and every one of them ended
    // its run cold.
    describe('gate remediation (Wave 0)', () => {
      // A real monitor.log path: the remediation round is an operator-visible
      // event, so the durable line is part of the contract, not incidental.
      let monitorDir: string;
      let monitorPath: string;
      const remediationInput = () => ({ ...INPUT, monitorPath });
      // An unwritten log and a log without the line both mean "not logged".
      const monitorLog = (): string =>
        existsSync(monitorPath) ? readFileSync(monitorPath, 'utf-8') : '';

      beforeEach(() => {
        monitorDir = mkdtempSync(path.join(os.tmpdir(), 'sdlc-remediate-'));
        monitorPath = path.join(monitorDir, 'monitor.log');
      });

      afterEach(() => rmSync(monitorDir, { recursive: true, force: true }));

      const redReviewer = () => {
        greenGates();
        review.mockResolvedValue(
          verdictOf('reviewer', 'breach', ['unsafe migration'])
        );
        aggregate.mockReturnValue({
          verdict: verdictOf('phase', 'breach', ['failing gates: reviewer']),
          exceptions: [
            {
              trigger: 'reviewer-disagreement' as const,
              taskId: 'T-01',
              context: ['unsafe migration'],
              recordedAt: 'x'
            }
          ]
        });
      };

      it('dispatches remediation with the reviewer and envelope verdicts', async () => {
        redReviewer();

        await handler.runTask(INPUT);

        expect(deploy).not.toHaveBeenCalled();
        expect(remediate).toHaveBeenCalledTimes(1);
        const call = remediate.mock.calls[0][0];
        expect(call.branch).toBe('sdlc/run-1/T-01');
        expect(call.task.id).toBe('T-01');
        expect(call.envelope).toBe(SPEC.envelope);
        expect(call.verdicts.map((v: GateVerdict) => v.gate)).toEqual([
          'reviewer',
          'envelope'
        ]);
      });

      it('suppresses the escalation and the merge attempt when a fix landed', async () => {
        redReviewer();
        remediate.mockResolvedValue({
          kind: 'remediated',
          attempt: 1,
          sha: 'fix-sha',
          detail: 'attempt 1/2 addressed [reviewer]'
        });

        await handler.runTask(remediationInput());

        // Filing a needs-human issue for a finding the engine is actively
        // fixing is exactly the noise that teaches an operator to ignore
        // escalations.
        expect(escalationPost).not.toHaveBeenCalled();
        expect(prMerge).not.toHaveBeenCalled();
        expect(state.exceptions).not.toContainEqual(
          expect.objectContaining({ trigger: 'merge-blocked' })
        );
        expect(monitorLog()).toContain(
          '[remediate] T-01 attempt 1/2 addressed [reviewer]'
        );
      });

      it('records a failed round in monitor.log so a spent attempt is visible', async () => {
        redReviewer();
        remediate.mockResolvedValue({
          kind: 'failed',
          attempt: 1,
          detail: 'remediation agent produced no commit'
        });

        await handler.runTask(remediationInput());

        expect(monitorLog()).toContain('[remediate] T-01 failed');
        expect(escalationPost).toHaveBeenCalled();
      });

      it('keeps the common skip out of monitor.log', async () => {
        redReviewer();

        await handler.runTask(remediationInput());

        // Most red gates have nothing remediable; logging every one would
        // bury the rounds that actually happened.
        expect(monitorLog()).not.toContain('[remediate]');
      });

      it('still escalates when remediation is skipped or fails', async () => {
        redReviewer();
        remediate.mockResolvedValue({
          kind: 'skipped',
          attempt: 2,
          detail: 'gate-fix attempts exhausted (2/2)'
        });

        await handler.runTask(INPUT);

        // An exhausted budget must be loud, not silently absorbed.
        expect(escalationPost).toHaveBeenCalled();
        expect(state.exceptions).toContainEqual(
          expect.objectContaining({ trigger: 'merge-blocked' })
        );
      });

      it('never remediates a green phase', async () => {
        greenGates();

        await handler.runTask(INPUT);

        expect(remediate).not.toHaveBeenCalled();
      });

      it('never remediates in shadow mode', async () => {
        redReviewer();

        await handler.runTask({ ...INPUT, shadow: true });

        // Shadow is calibration: it observes what the gates would say and
        // changes nothing on the branch.
        expect(remediate).not.toHaveBeenCalled();
      });

      it('does not remediate again from a cached early-halt phase verdict on resume', async () => {
        redReviewer();
        // Default remediate = skipped → early halt records phase without sandbox.

        await handler.runTask(remediationInput());
        expect(remediate).toHaveBeenCalledTimes(1);
        expect(deploy).not.toHaveBeenCalled();

        // Resume replays the step graph; the cached phase verdict must not
        // spend another remediation round on the same red head.
        await handler.runTask(remediationInput());
        expect(remediate).toHaveBeenCalledTimes(1);
        expect(deploy).not.toHaveBeenCalled();
      });
    });

    describe('early skip-sandbox on envelope/reviewer red (SPEC-BUG-early-reviewer-remediation-P1 T-01)', () => {
      it('never calls sandbox deploy when reviewer returns non-pass in enforce', async () => {
        greenGates();
        review.mockResolvedValue(
          verdictOf('reviewer', 'breach', ['unsafe migration'])
        );
        aggregate.mockReturnValue({
          verdict: verdictOf('phase', 'breach', ['failing gates: reviewer']),
          exceptions: [
            {
              trigger: 'reviewer-disagreement' as const,
              taskId: 'T-01',
              context: ['unsafe migration'],
              recordedAt: 'x'
            }
          ]
        });

        await handler.runTask(INPUT);

        expect(deploy).not.toHaveBeenCalled();
        expect(ciEvaluate).not.toHaveBeenCalled();
        expect(verify).not.toHaveBeenCalled();
      });

      it('invokes remediation before any sandbox call and abandons on success', async () => {
        greenGates();
        review.mockResolvedValue(
          verdictOf('reviewer', 'breach', ['unsafe migration'])
        );
        const callOrder: string[] = [];
        remediate.mockImplementation(async () => {
          callOrder.push('remediate');
          return {
            kind: 'remediated',
            attempt: 1,
            sha: 'fix-sha',
            detail: 'attempt 1/2 addressed [reviewer]'
          };
        });
        deploy.mockImplementation(async () => {
          callOrder.push('deploy');
          return {
            verdict: verdictOf('sandbox', 'pass'),
            healthReport: 'ok'
          };
        });

        await handler.runTask(INPUT);

        expect(callOrder).toEqual(['remediate']);
        expect(deploy).not.toHaveBeenCalled();
        expect(escalationPost).not.toHaveBeenCalled();
        expect(prMerge).not.toHaveBeenCalled();
      });

      it('re-gates the remediated tip from envelope onward, sandboxing only once green', async () => {
        greenGates();
        review.mockResolvedValue(
          verdictOf('reviewer', 'breach', ['unsafe migration'])
        );
        remediate.mockResolvedValue({
          kind: 'remediated',
          attempt: 1,
          sha: 'fix-sha',
          detail: 'attempt 1/2 addressed [reviewer]'
        });

        await handler.runTask(INPUT);

        expect(evaluate).toHaveBeenCalledTimes(1);
        expect(review).toHaveBeenCalledTimes(1);
        expect(deploy).not.toHaveBeenCalled();

        // Re-selection brings the task back on the new head the remediation
        // committed. Every step key chains off that SHA, so nothing is served
        // from the cache of the rejected tip: envelope and reviewer judge the
        // fix first, and only their green unlocks the sandbox.
        gitHeadSha.mockReturnValue('fix-sha');
        review.mockResolvedValue(verdictOf('reviewer', 'pass'));

        await handler.runTask(INPUT);

        expect(evaluate).toHaveBeenCalledTimes(2);
        expect(review).toHaveBeenCalledTimes(2);
        expect(deploy).toHaveBeenCalledWith(
          expect.objectContaining({
            worktreePath: '/runs/run-1/worktrees/T-01'
          })
        );
      });

      it('skips sandbox and escalates loudly when remediation is skipped or fails', async () => {
        greenGates();
        review.mockResolvedValue(
          verdictOf('reviewer', 'breach', ['unsafe migration'])
        );
        remediate.mockResolvedValue({
          kind: 'failed',
          attempt: 1,
          detail: 'remediation agent produced no commit'
        });
        aggregate.mockReturnValue({
          verdict: verdictOf('phase', 'breach', ['failing gates: reviewer']),
          exceptions: [
            {
              trigger: 'reviewer-disagreement' as const,
              taskId: 'T-01',
              context: ['unsafe migration'],
              recordedAt: 'x'
            }
          ]
        });

        await handler.runTask(INPUT);

        expect(deploy).not.toHaveBeenCalled();
        expect(escalationPost).toHaveBeenCalled();
        expect(state.exceptions).toContainEqual(
          expect.objectContaining({ trigger: 'merge-blocked' })
        );
      });

      it('envelope non-pass follows the same skip-sandbox + early-remediation path', async () => {
        greenGates();
        evaluate.mockResolvedValue(
          verdictOf('envelope', 'breach', ['outside allowedPaths: x'])
        );
        const callOrder: string[] = [];
        remediate.mockImplementation(async () => {
          callOrder.push('remediate');
          return {
            kind: 'remediated',
            attempt: 1,
            sha: 'fix-sha',
            detail: 'attempt 1/2 addressed [envelope]'
          };
        });
        deploy.mockImplementation(async () => {
          callOrder.push('deploy');
          return { verdict: verdictOf('sandbox', 'pass') };
        });

        await handler.runTask(INPUT);

        expect(callOrder).toEqual(['remediate']);
        expect(deploy).not.toHaveBeenCalled();
      });

      it('shadow mode never early-remediates and keeps full gate order', async () => {
        greenGates();
        review.mockResolvedValue(
          verdictOf('reviewer', 'breach', ['unsafe migration'])
        );

        await handler.runTask({ ...INPUT, shadow: true });

        expect(remediate).not.toHaveBeenCalled();
        expect(deploy).toHaveBeenCalled();
        expect(verify).toHaveBeenCalled();
        expect(ciEvaluate).toHaveBeenCalled();
      });

      it('still deploys sandbox when envelope and reviewer both pass', async () => {
        greenGates();

        await handler.runTask(INPUT);

        // Task-head deploy still runs on the green path (phase-boundary may
        // also deploy after merge — both are expected).
        expect(
          deploy.mock.calls.some(
            ([arg]: [
              { worktreePath?: string; ledger?: { trigger?: string } }
            ]) =>
              arg.worktreePath === '/runs/run-1/worktrees/T-01' &&
              arg.ledger?.trigger === 'task'
          )
        ).toBe(true);
        expect(remediate).not.toHaveBeenCalled();
      });
    });

    it('with the shadow flag set, verdicts are recorded but no merge call is ever issued', async () => {
      greenGates();

      await handler.runTask({ ...INPUT, shadow: true });

      expect(prMerge).not.toHaveBeenCalled();
      // Verdicts still recorded (envelope, reviewer, sandbox, verification,
      // ci, phase).
      expect(appendVerdict).toHaveBeenCalledTimes(6);
      expect(state.exceptions).toEqual([]);
    });

    it('green gates without a recorded PR block with an escalation instead of merging', async () => {
      greenGates();
      openTaskPr.mockImplementation(() => {
        throw new WorkflowError('gh unavailable', 'GH_FAILED');
      });

      await handler.runTask({ ...INPUT, retryBackoffMs: 0 });

      expect(prMerge).not.toHaveBeenCalled();
      expect(state.exceptions).toContainEqual(
        expect.objectContaining({
          trigger: 'merge-blocked',
          context: ['all gates green but no PR is recorded for the task']
        })
      );
    });

    it('a failed merge call records the escalation without crashing the run', async () => {
      greenGates();
      prMerge.mockImplementation(() => {
        throw new WorkflowError('merge conflict', 'GH_FAILED', ['dirty']);
      });
      mergeCommitOid.mockReturnValue(null);

      const result = await handler.runTask(INPUT);

      expect(result.outcome).toBe('executed');
      expect(mergeCommitOid).toHaveBeenCalledWith('/repo', 7);
      expect(state.exceptions).toContainEqual(
        expect.objectContaining({
          trigger: 'merge-blocked',
          context: [expect.stringContaining('merge conflict')]
        })
      );
      expect(escalationPost).toHaveBeenCalled();
      expect(state.taskResults['T-01'].mergedSha).toBeUndefined();
    });

    it('reconciles a thrown merge when GitHub reports the PR already merged (checked-out branch false negative)', async () => {
      // Repro: gh pr merge --delete-branch exits non-zero because the run
      // worktree still has the branch checked out, even though the merge
      // commit already landed on GitHub.
      greenGates();
      prMerge.mockImplementation(() => {
        throw new WorkflowError('gh pr failed', 'GH_FAILED', [
          'failed to delete local branch sdlc/run-1/T-01: cannot delete branch checked out at worktree'
        ]);
      });
      mergeCommitOid.mockReturnValue('reconciled-merge-sha');

      await handler.runTask({ ...INPUT, chronicleRepo: '/chronicle' });

      expect(mergeCommitOid).toHaveBeenCalledWith('/repo', 7);
      expect(state.taskResults['T-01'].mergedSha).toBe('reconciled-merge-sha');
      expect(state.mergedSha).toBe('reconciled-merge-sha');
      expect(state.exceptions).not.toContainEqual(
        expect.objectContaining({ trigger: 'merge-blocked' })
      );
      expect(escalationPost).not.toHaveBeenCalled();
      expect(recordMerge).toHaveBeenCalledWith(
        expect.objectContaining({
          mergedSha: 'reconciled-merge-sha',
          taskId: 'T-01',
          approvedBy: 'machine-gates'
        })
      );
      expect(gitFetch).toHaveBeenCalledWith('/repo');
      expect(removeWorktreeAsync).toHaveBeenCalled();
      // Phase gate sees the task as merged → boundary runs.
      expect(
        deploy.mock.calls.filter(([arg]) =>
          String(arg.worktreePath).includes('_phase')
        )
      ).toHaveLength(1);
    });
  });

  describe('P3 T-05 phase boundary and veto', () => {
    const greenGates = () => {
      evaluate.mockResolvedValue(verdictOf('envelope', 'pass'));
      review.mockResolvedValue(verdictOf('reviewer', 'pass'));
      verify.mockResolvedValue({
        verdict: verdictOf('verification', 'pass'),
        criteria: criterionVerdicts
      });
      ciEvaluate.mockResolvedValue(verdictOf('ci', 'pass'));
      aggregate.mockReturnValue({
        verdict: verdictOf('phase', 'pass'),
        exceptions: []
      });
    };

    const phaseDeployCalls = () =>
      deploy.mock.calls.filter(([arg]) => arg.worktreePath.includes('_phase'));

    it('deploys the merged default branch exactly once and posts the phase digest with merge links', async () => {
      greenGates();

      await handler.runTask({ ...INPUT, chronicleRepo: '/chronicle' });

      // The phase deploy targets the merged default branch head in the
      // dedicated _phase worktree — not a task branch.
      const calls = phaseDeployCalls();
      expect(calls).toHaveLength(1);
      expect(calls[0][0]).toEqual(
        expect.objectContaining({
          sha: 'main-sha',
          // The phase ships everything the wave merged, so its deploy range
          // starts at the tip the run began from (SPEC-PRD-0011-P4 T-01)...
          baseSha: 'base-sha',
          // ...and it enters the ledger as a phase-boundary trigger, which is
          // what lets it stand down for a push deploy of the same content
          // (SPEC-PRD-0022-P1 T-03).
          ledger: expect.objectContaining({
            contentSha: 'tree-sha',
            trigger: 'phase-boundary',
            taskId: 'phase'
          })
        })
      );
      // The phase digest carries the merged SHAs and the recorded verdicts.
      const phasePost = digestPost.mock.calls.find(
        ([arg]) => arg.taskId === 'phase'
      );
      expect(phasePost).toBeDefined();
      expect(phasePost?.[0].merges).toEqual([
        { taskId: 'T-01', mergedSha: 'merged-sha-abc' }
      ]);
      expect(phasePost?.[0].verdicts.length).toBeGreaterThan(0);

      // Resume: the boundary is step-cached — no second deploy, no
      // duplicate digest.
      await handler.runTask({ ...INPUT, chronicleRepo: '/chronicle' });
      expect(phaseDeployCalls()).toHaveLength(1);
      expect(
        digestPost.mock.calls.filter(([arg]) => arg.taskId === 'phase')
      ).toHaveLength(1);
    });

    it('does not reach the phase boundary while any task is unmerged', async () => {
      greenGates();
      prMerge.mockImplementation(() => {
        throw new WorkflowError('merge conflict', 'GH_FAILED');
      });

      await handler.runTask({ ...INPUT, chronicleRepo: '/chronicle' });

      expect(phaseDeployCalls()).toHaveLength(0);
      expect(
        digestPost.mock.calls.filter(([arg]) => arg.taskId === 'phase')
      ).toHaveLength(0);
    });

    it('replays the phase boundary on a no-ready-task resume', async () => {
      greenGates();
      // Seed a fully-merged state and force the executor into the
      // no-ready-task kind so the resume path is exercised.
      state.taskResults['T-01'].mergedSha = 'merged-sha-abc';
      executeReady.mockResolvedValue({
        kind: 'no-ready-task',
        spec: SPEC,
        state,
        outcomes: []
      });

      await handler.runTask({ ...INPUT, chronicleRepo: '/chronicle' });

      expect(phaseDeployCalls()).toHaveLength(1);
      expect(
        digestPost.mock.calls.filter(([arg]) => arg.taskId === 'phase')
      ).toHaveLength(1);
    });

    it('leaves the phase-deploy step uncached when the sandbox deploy fails', async () => {
      greenGates();
      deploy.mockResolvedValue({
        verdict: verdictOf('sandbox', 'breach', ['deploy failed']),
        record: { sha: 'main-sha', status: 'failed', recordedAt: 'x' }
      });

      await handler.runTask({ ...INPUT, chronicleRepo: '/chronicle' });

      expect(phaseDeployCalls()).toHaveLength(1);
      // Step not recorded → digest not posted → retryable on next run.
      expect(
        Object.values(state.steps).some(step => step.name === 'phase-deploy')
      ).toBe(false);
      expect(
        digestPost.mock.calls.filter(([arg]) => arg.taskId === 'phase')
      ).toHaveLength(0);
    });

    it('deploys the phase but skips the digest without --chronicle-repo', async () => {
      greenGates();

      await handler.runTask(INPUT);

      expect(phaseDeployCalls()).toHaveLength(1);
      expect(
        digestPost.mock.calls.filter(([arg]) => arg.taskId === 'phase')
      ).toHaveLength(0);
    });

    // SPEC-PRD-0023-P1 T-02 / T-05: the final task merging is what triggers
    // closeout, and the digest that follows links the PR it produced.
    describe('closeout on final task merge (SPEC-PRD-0023-P1)', () => {
      it('derives the closeout PR from the run verdicts with no authoring step', async () => {
        greenGates();

        await handler.runTask({ ...INPUT, chronicleRepo: '/chronicle' });

        expect(closeoutAggregate).toHaveBeenCalledWith({
          runsDir: '/runs',
          runId: 'run-1',
          spec: SPEC
        });
        expect(closeoutGenerate).toHaveBeenCalledWith({
          repoPath: '/repo',
          runsDir: '/runs',
          runId: 'run-1',
          spec: SPEC,
          specRelPath: 'specs/PRD-0099/phase-2-spec.md',
          aggregate: CLOSEOUT_AGGREGATE
        });
      });

      it('links the closeout PR into the phase digest', async () => {
        greenGates();

        await handler.runTask({ ...INPUT, chronicleRepo: '/chronicle' });

        const phasePost = digestPost.mock.calls.find(
          ([arg]) => arg.taskId === 'phase'
        );
        expect(phasePost?.[0].closeoutPrUrl).toBe(
          'https://github.com/o/r/pull/9'
        );
      });

      it('re-runs the generator on resume so a late closeout still lands', async () => {
        greenGates();

        await handler.runTask({ ...INPUT, chronicleRepo: '/chronicle' });
        await handler.runTask({ ...INPUT, chronicleRepo: '/chronicle' });

        // Unlike the deploy and digest, closeout is not step-cached: the
        // verdict set it derives from keeps moving until the phase is done.
        expect(closeoutGenerate).toHaveBeenCalledTimes(2);
      });

      it('posts the digest with the link once a later closeout succeeds', async () => {
        greenGates();
        closeoutGenerate.mockResolvedValueOnce({
          kind: 'unchanged',
          tickedCount: 0,
          remainderCount: 1,
          detail: 'no closeout PR exists yet'
        });

        await handler.runTask({ ...INPUT, chronicleRepo: '/chronicle' });
        const first = digestPost.mock.calls.filter(
          ([arg]) => arg.taskId === 'phase'
        );
        expect(first).toHaveLength(1);
        expect(first[0][0].closeoutPrUrl).toBeUndefined();

        await handler.runTask({ ...INPUT, chronicleRepo: '/chronicle' });

        const posts = digestPost.mock.calls.filter(
          ([arg]) => arg.taskId === 'phase'
        );
        expect(posts).toHaveLength(2);
        expect(posts[1][0].closeoutPrUrl).toBe('https://github.com/o/r/pull/9');
      });

      it('does not block the run when closeout generation throws', async () => {
        greenGates();
        closeoutGenerate.mockRejectedValue(
          new WorkflowError('gh pr create failed', 'GH_FAILED', ['403'])
        );

        const result = await handler.runTask({
          ...INPUT,
          chronicleRepo: '/chronicle'
        });

        expect(result.outcome).toBe('executed');
        const phasePost = digestPost.mock.calls.find(
          ([arg]) => arg.taskId === 'phase'
        );
        expect(phasePost?.[0].closeoutPrUrl).toBeUndefined();
      });

      it('never closes out a shadow run', async () => {
        greenGates();

        await handler.runTask({
          ...INPUT,
          chronicleRepo: '/chronicle',
          shadow: true
        });

        expect(closeoutGenerate).not.toHaveBeenCalled();
      });

      it('refuses a spec outside the repo instead of guessing a path', async () => {
        greenGates();

        await handler.runTask({
          ...INPUT,
          specPath: '/elsewhere/spec.md',
          chronicleRepo: '/chronicle'
        });

        expect(closeoutGenerate).not.toHaveBeenCalled();
      });
    });

    describe('checkVeto', () => {
      const VETO_INPUT = {
        runsDir: '/runs',
        runId: 'run-1',
        repoPath: '/repo',
        chronicleRepo: '/chronicle'
      };

      beforeEach(() => {
        const vetoState = makeState();
        vetoState.taskResults['T-01'] = {
          taskId: 'T-01',
          status: 'completed',
          branch: 'sdlc/run-1/T-01',
          mergedSha: 'merge-sha-1',
          recordedAt: '2026-08-01T00:00:00Z'
        };
        vetoState.taskResults['T-02'] = {
          taskId: 'T-02',
          status: 'completed',
          branch: 'sdlc/run-1/T-02',
          mergedSha: 'merge-sha-2',
          recordedAt: '2026-08-01T01:00:00Z'
        };
        stateLoad.mockReturnValue(vetoState);
      });

      it('a [veto] tag reverts the phase merges through a PR, redeploys the sandbox, and records the Chronicle artifact', async () => {
        itemTags.mockReturnValue(['follow-up', 'veto']);

        const result = await handler.checkVeto(VETO_INPUT);

        expect(result).toEqual({
          veto: true,
          reverted: true,
          prUrl: 'https://github.com/org/repo/pull/99'
        });
        // Most recent merge reverted first.
        expect(revertMerge.mock.calls.map(call => call[1])).toEqual([
          'merge-sha-2',
          'merge-sha-1'
        ]);
        expect(gitPush).toHaveBeenCalledWith(
          expect.stringContaining('_revert'),
          'sdlc/run-1/revert'
        );
        expect(prCreate).toHaveBeenCalled();
        // Sandbox redeployed at the reverted SHA — through the same
        // sandbox-only deploy service, no environment parameter exists.
        const revertDeploys = deploy.mock.calls.filter(([arg]) =>
          arg.worktreePath.includes('_revert')
        );
        expect(revertDeploys).toHaveLength(1);
        expect(Object.keys(revertDeploys[0][0]).sort()).toEqual([
          'baseSha',
          'ledger',
          'previous',
          'sha',
          'worktreePath'
        ]);
        expect(recordRevert).toHaveBeenCalledWith(
          expect.objectContaining({
            revertedShas: ['merge-sha-1', 'merge-sha-2'],
            prUrl: 'https://github.com/org/repo/pull/99'
          })
        );

        // Idempotent: a second check replays the cached revert.
        const second = await handler.checkVeto(VETO_INPUT);
        expect(second.reverted).toBe(true);
        expect(revertMerge).toHaveBeenCalledTimes(2); // no new reverts
      });

      it('BUG-reviewer-house-bar-P1 T-02: passes the reverted tasks\u2019 gate verdicts to the Chronicle so they can be annotated vetoed', async () => {
        itemTags.mockReturnValue(['veto']);
        const vetoState = makeState();
        vetoState.taskResults['T-01'] = {
          taskId: 'T-01',
          status: 'completed',
          branch: 'sdlc/run-1/T-01',
          mergedSha: 'merge-sha-1',
          recordedAt: '2026-08-01T00:00:00Z'
        };
        vetoState.taskResults['T-02'] = {
          taskId: 'T-02',
          status: 'completed',
          branch: 'sdlc/run-1/T-02',
          mergedSha: 'merge-sha-2',
          recordedAt: '2026-08-01T01:00:00Z'
        };
        vetoState.verdicts = [
          { ...verdictOf('reviewer', 'pass'), taskId: 'T-01' },
          { ...verdictOf('ci', 'pass'), taskId: 'T-02' },
          // Not part of the reverted phase — must not be forwarded.
          { ...verdictOf('envelope', 'pass'), taskId: 'T-03' }
        ];
        stateLoad.mockReturnValue(vetoState);

        await handler.checkVeto(VETO_INPUT);

        expect(recordRevert).toHaveBeenCalledWith(
          expect.objectContaining({
            revertedVerdicts: expect.arrayContaining([
              expect.objectContaining({ gate: 'reviewer', taskId: 'T-01' }),
              expect.objectContaining({ gate: 'ci', taskId: 'T-02' })
            ])
          })
        );
        const forwarded = recordRevert.mock.calls[0][0].revertedVerdicts;
        expect(forwarded).toHaveLength(2);
        expect(forwarded.some((v: GateVerdict) => v.taskId === 'T-03')).toBe(
          false
        );
      });

      it('absence of a veto tag changes nothing', async () => {
        itemTags.mockReturnValue(['follow-up']);

        const result = await handler.checkVeto(VETO_INPUT);

        expect(result).toEqual({ veto: false, reverted: false });
        expect(revertMerge).not.toHaveBeenCalled();
        expect(deploy).not.toHaveBeenCalled();
        expect(recordRevert).not.toHaveBeenCalled();
      });

      it('does nothing when the run has no merges', async () => {
        stateLoad.mockReturnValue(makeState());

        const result = await handler.checkVeto(VETO_INPUT);

        expect(result).toEqual({ veto: false, reverted: false });
        expect(itemTags).not.toHaveBeenCalled();
      });

      it('rejects check-veto for an unknown run', async () => {
        stateLoad.mockReturnValue(null);

        await expect(handler.checkVeto(VETO_INPUT)).rejects.toThrow(
          expect.objectContaining({ code: 'RUN_NOT_FOUND' })
        );
      });
    });
  });

  describe('SPEC-BUG-retro-and-queued-plans-P1 T-01 bug-run retro', () => {
    const greenGates = () => {
      evaluate.mockResolvedValue(verdictOf('envelope', 'pass'));
      review.mockResolvedValue(verdictOf('reviewer', 'pass'));
      verify.mockResolvedValue({
        verdict: verdictOf('verification', 'pass'),
        criteria: criterionVerdicts
      });
      ciEvaluate.mockResolvedValue(verdictOf('ci', 'pass'));
      aggregate.mockReturnValue({
        verdict: verdictOf('phase', 'pass'),
        exceptions: []
      });
    };

    const bugPool = (): PoolOutcome => ({
      kind: 'executed',
      spec: BUG_SPEC,
      state,
      outcomes: [taskOutcome()]
    });

    it('produces exactly one sdlc.retro.v1 artifact with stage-attributed recommendations, idempotent across resume', async () => {
      greenGates();
      specRead.mockReturnValue(BUG_SPEC);
      executeReady.mockImplementation(async () => bugPool());

      await handler.runTask({ ...INPUT, chronicleRepo: '/chronicle' });

      expect(retroPost).toHaveBeenCalledTimes(1);
      expect(retroPost).toHaveBeenCalledWith(
        expect.objectContaining({
          chronicleRepo: '/chronicle',
          runId: 'run-1',
          specId: BUG_SPEC.id,
          context: BUG_SPEC.context,
          verdicts: state.verdicts,
          exceptions: state.exceptions
        })
      );
      expect(
        Object.values(state.steps).some(step => step.name === 'retro')
      ).toBe(true);

      executeReady.mockResolvedValue({
        kind: 'no-ready-task',
        spec: BUG_SPEC,
        state,
        outcomes: []
      });
      await handler.runTask({ ...INPUT, chronicleRepo: '/chronicle' });
      expect(retroPost).toHaveBeenCalledTimes(1);
    });

    it('non-bug runs produce no retro artifact and no behavior change', async () => {
      greenGates();

      const result = await handler.runTask({
        ...INPUT,
        chronicleRepo: '/chronicle'
      });

      expect(retroPost).not.toHaveBeenCalled();
      expect(result.outcome).toBe('executed');
      expect(
        digestPost.mock.calls.some(([arg]) => arg.taskId === 'phase')
      ).toBe(true);
    });

    it('a retro inference failure degrades loud-but-nonblocking: the run completes and monitor.log warns', async () => {
      const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'sdlc-retro-'));
      const monitorPath = path.join(tmpRoot, 'monitor.log');
      try {
        greenGates();
        specRead.mockReturnValue(BUG_SPEC);
        executeReady.mockImplementation(async () => bugPool());
        retroPost.mockRejectedValue(
          new WorkflowError('model unavailable', 'INFERENCE_FAILED', [
            'timeout'
          ])
        );

        const result = await handler.runTask({
          ...INPUT,
          chronicleRepo: '/chronicle',
          monitorPath
        });

        expect(result.outcome).toBe('executed');
        const monitor = readFileSync(monitorPath, 'utf8');
        expect(monitor).toContain('[retro] WARNING');
        expect(monitor).toContain('model unavailable');
        expect(
          Object.values(state.steps).some(step => step.name === 'retro')
        ).toBe(false);
      } finally {
        rmSync(tmpRoot, { recursive: true, force: true });
      }
    });
  });

  it('skips digest and chronicle steps without --chronicle-repo', async () => {
    await handler.runTask(INPUT);

    expect(digestPost).not.toHaveBeenCalled();
    expect(chronicleRecord).not.toHaveBeenCalled();
  });

  it('posts exactly one digest and commits artifacts when a chronicle repo is given (T-07/T-08)', async () => {
    await handler.runTask({ ...SHADOW_INPUT, chronicleRepo: '/chronicle' });

    expect(chronicleRecord).toHaveBeenCalledTimes(1);
    expect(chronicleRecord).toHaveBeenCalledWith({
      chronicleRepo: '/chronicle',
      spec: SPEC,
      state
    });
    expect(digestPost).toHaveBeenCalledTimes(1);
    const posted = digestPost.mock.calls[0][0];
    expect(posted.taskId).toBe('T-01');
    expect(posted.phaseVerdict).toBe(phaseVerdict);
    expect(posted.verdicts).toHaveLength(6); // all gate verdicts for the task
    // Shadow records the ledger exception but does not merge-block.
    expect(posted.exceptions).toEqual([
      expect.objectContaining({ trigger: 'envelope-breach' })
    ]);
  });

  it('kill-resume at any boundary produces no duplicate side effects (T-09)', async () => {
    const chronicleInput = { ...SHADOW_INPUT, chronicleRepo: '/chronicle' };
    await handler.runTask(chronicleInput);

    // Simulate a kill directly after the first full pass: the same
    // persisted state is loaded and the run is invoked again.
    await handler.runTask(chronicleInput);

    // Every gate ran once; every side effect happened once.
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(review).toHaveBeenCalledTimes(1);
    expect(deploy).toHaveBeenCalledTimes(1);
    expect(verify).toHaveBeenCalledTimes(1);
    expect(ciEvaluate).toHaveBeenCalledTimes(1);
    expect(aggregate).toHaveBeenCalledTimes(1);
    expect(digestPost).toHaveBeenCalledTimes(1);
    expect(chronicleRecord).toHaveBeenCalledTimes(1);
    expect(appendVerdict).toHaveBeenCalledTimes(6);
  });

  it('resumes mid-pipeline from cached steps after a kill between gates (T-09)', async () => {
    // First pass killed at the verification gate. A gate throw is a genuine
    // stop — unlike a non-gate step failure, which the T-04 retry executor
    // now absorbs rather than letting it end the run.
    verify.mockRejectedValueOnce(new Error('killed'));
    await expect(handler.runTask(SHADOW_INPUT)).rejects.toThrow('killed');
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(review).toHaveBeenCalledTimes(1);
    expect(deploy).toHaveBeenCalledTimes(1);

    // Resume: envelope, reviewer and sandbox come from the step cache; only
    // the killed step and everything after it executes.
    const result = await handler.runTask(SHADOW_INPUT);

    expect(result.outcome).toBe('executed');
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(review).toHaveBeenCalledTimes(1);
    expect(deploy).toHaveBeenCalledTimes(1);
    expect(verify).toHaveBeenCalledTimes(2); // first call was the kill
    expect(aggregate).toHaveBeenCalledTimes(1);
  });

  // T-04: the sandbox deploy is retried on a *thrown* error, but an unhealthy
  // deploy is a verdict — retrying that would make the gate advisory.
  it('retries a throwing sandbox deploy and blocks the gate once exhausted', async () => {
    deploy.mockRejectedValue(new Error('deploy host unreachable'));

    await handler.runTask({ ...SHADOW_INPUT, retryBackoffMs: 0 });

    expect(deploy).toHaveBeenCalledTimes(3);
    expect(state.verdicts).toContainEqual(
      expect.objectContaining({
        gate: 'sandbox',
        outcome: 'blocked',
        reasons: [expect.stringContaining('deploy host unreachable')]
      })
    );
  });

  it('never retries an unhealthy sandbox verdict', async () => {
    deploy.mockResolvedValue({
      verdict: verdictOf('sandbox', 'breach', ['health check never echoed']),
      record: { sha: 'head-sha', status: 'unhealthy', recordedAt: 'x' }
    });

    await handler.runTask({ ...SHADOW_INPUT, retryBackoffMs: 0 });

    expect(deploy).toHaveBeenCalledTimes(1);
  });

  // T-04's third non-gate step: a git push against a separate ledger repo,
  // the most network-flaky operation in the pipeline.
  it('retries a failing Chronicle commit and records the recovery', async () => {
    chronicleRecord.mockRejectedValueOnce(new Error('remote hung up'));

    await handler.runTask({
      ...INPUT,
      chronicleRepo: '/chronicle',
      retryBackoffMs: 0
    });

    expect(chronicleRecord).toHaveBeenCalledTimes(2);
    const step = Object.entries(state.steps).find(([key]) =>
      key.startsWith('chronicle-record:')
    )?.[1];
    expect(step?.recovery).toMatchObject({
      path: 'chronicle-record:T-01',
      escalated: false
    });
  });

  it('leaves the Chronicle step uncached when its retries are exhausted', async () => {
    chronicleRecord.mockRejectedValue(new Error('remote hung up'));

    await handler.runTask({
      ...INPUT,
      chronicleRepo: '/chronicle',
      retryBackoffMs: 0
    });

    expect(chronicleRecord).toHaveBeenCalledTimes(3);
    // Caching a step that never happened would silently skip the artifact
    // commit on resume, losing the run's evidence for good.
    expect(
      Object.keys(state.steps).some(key => key.startsWith('chronicle-record:'))
    ).toBe(false);
  });

  // T-04 AC: after a retry succeeds the run resumes from the step cache in
  // state.json with zero hand-edits, and the recovered step is not repeated.
  it('resumes from the step cache after a retry, with no duplicate side effect', async () => {
    openTaskPr.mockImplementationOnce(() => {
      throw new WorkflowError('gh pr failed', 'GH_FAILED', ['boom']);
    });
    deploy.mockRejectedValueOnce(new Error('deploy host unreachable'));
    chronicleRecord.mockRejectedValueOnce(new Error('remote hung up'));

    const first = await handler.runTask({
      ...SHADOW_INPUT,
      chronicleRepo: '/chronicle',
      retryBackoffMs: 0
    });
    expect(first.outcome).toBe('executed');
    // One recovered call each: the failure plus the successful retry.
    expect(openTaskPr).toHaveBeenCalledTimes(2);
    expect(deploy).toHaveBeenCalledTimes(2);
    expect(chronicleRecord).toHaveBeenCalledTimes(2);

    const savedSteps = { ...state.steps };
    await handler.runTask({
      ...INPUT,
      chronicleRepo: '/chronicle',
      retryBackoffMs: 0
    });

    // Nothing re-executed on resume — a second PR, deploy, or ledger commit
    // is the duplicate side effect this acceptance criterion is about.
    expect(openTaskPr).toHaveBeenCalledTimes(2);
    expect(deploy).toHaveBeenCalledTimes(2);
    expect(chronicleRecord).toHaveBeenCalledTimes(2);
    // Resume read the recovered steps as-is: same keys, same recovery trail.
    expect(Object.keys(state.steps).sort()).toEqual(
      Object.keys(savedSteps).sort()
    );
    // Every cached step was persisted by the engine, not patched in by hand.
    expect(recordStep).toHaveBeenCalledWith(
      '/runs',
      expect.anything(),
      expect.stringMatching(/^pr:T-01:/),
      expect.objectContaining({ recovery: expect.anything() })
    );
  });

  it('shows run status: tasks, cached steps, verdicts, exceptions (T-09)', async () => {
    const loaded = makeState();
    loaded.taskResults['T-01'] = {
      taskId: 'T-01',
      status: 'completed',
      branch: 'sdlc/run-1/T-01',
      inputsDigest: 'impl-digest',
      recordedAt: 'x'
    };
    loaded.steps['implementation:T-01:impl-digest'] = {
      name: 'implementation',
      taskId: 'T-01',
      inputsDigest: 'impl-digest',
      completedAt: '2026-08-01T00:00:00Z'
    };
    loaded.steps['envelope:T-01:env-digest'] = {
      name: 'envelope',
      taskId: 'T-01',
      inputsDigest: 'env-digest',
      verdict: verdictOf('envelope', 'pass'),
      completedAt: '2026-08-01T00:01:00Z'
    };
    loaded.verdicts.push(verdictOf('envelope', 'pass'));
    loaded.exceptions.push({
      trigger: 'reviewer-disagreement',
      taskId: 'T-01',
      context: ['disagree'],
      recordedAt: 'x'
    });
    loaded.sandbox = { sha: 'head-sha', status: 'healthy', recordedAt: 'x' };
    loaded.mergedSha = 'abc123';
    stateLoad.mockReturnValue(loaded);

    handler.showStatus({ runsDir: '/runs', runId: 'run-1' });

    const output = (console.log as jest.Mock).mock.calls
      .map(call => String(call[0]))
      .join('\n');
    expect(output).toContain('Run run-1');
    // P3 T-06 categories: escalated takes precedence over completed-unmerged.
    expect(output).toContain('T-01 halted-escalated');
    expect(output).toContain('T-01 implementation');
    expect(output).toContain('T-01 envelope → pass');
    expect(output).toContain('reviewer-disagreement');
    expect(output).toContain('head-sha healthy');
    expect(output).toContain('merged: abc123');
    expect(output).toContain('spend:');
  });

  it('shows placeholders for a fresh run and throws for an unknown one', () => {
    stateLoad.mockReturnValue(makeState());
    handler.showStatus({ runsDir: '/runs', runId: 'run-1' });
    const output = (console.log as jest.Mock).mock.calls
      .map(call => String(call[0]))
      .join('\n');
    // Spec tasks surface as not-started when nothing has been attempted.
    expect(output).toContain('T-01 not-started');
    expect(output).toContain('(none completed)');
    expect(output).toContain('(none recorded)');

    stateLoad.mockReturnValue(null);
    expect(() =>
      handler.showStatus({ runsDir: '/runs', runId: 'run-x' })
    ).toThrow(WorkflowError);
  });

  it('status reports a launch-only run (startedAt + digest) instead of RUN_NOT_FOUND (#37)', () => {
    const launchOnly = makeState();
    launchOnly.startedAt = '2026-08-04T12:00:00.000Z';
    launchOnly.specDigest = 'abcdef0123456789digest';
    launchOnly.launchArgv = ['node', 'sdlc-workflow', 'run'];
    stateLoad.mockReturnValue(launchOnly);

    handler.showStatus({ runsDir: '/runs', runId: 'run-1' });

    const output = (console.log as jest.Mock).mock.calls
      .map(call => String(call[0]))
      .join('\n');
    expect(output).toContain('Run run-1');
    expect(output).toContain('started: 2026-08-04T12:00:00.000Z');
    expect(output).toContain('digest: abcdef012345');
  });

  it('status falls back to recorded results when the spec file is gone', () => {
    specRead.mockImplementation(() => {
      throw new Error('ENOENT');
    });
    const loaded = makeState();
    loaded.taskResults['T-01'] = {
      taskId: 'T-01',
      status: 'completed',
      mergedSha: 'm1',
      recordedAt: 'x'
    };
    stateLoad.mockReturnValue(loaded);

    handler.showStatus({ runsDir: '/runs', runId: 'run-1' });
    const output = (console.log as jest.Mock).mock.calls
      .map(call => String(call[0]))
      .join('\n');
    expect(output).toContain('T-01 merged');
  });

  it('status categorizes a mixed run into merged / escalated / blocked-by-dependency (P3 T-06)', () => {
    const loaded = makeState();
    loaded.specPath = '/specs/spec.md';
    loaded.taskResults['T-01'] = {
      taskId: 'T-01',
      status: 'completed',
      mergedSha: 'merged-1',
      recordedAt: 'x'
    };
    loaded.taskResults['T-02'] = {
      taskId: 'T-02',
      status: 'completed',
      recordedAt: 'x'
    };
    loaded.exceptions.push({
      trigger: 'envelope-breach',
      taskId: 'T-02',
      context: ['outside'],
      recordedAt: 'x'
    });
    specRead.mockReturnValue({
      ...SPEC,
      tasks: [
        SPEC.tasks[0],
        {
          ...SPEC.tasks[0],
          id: 'T-02',
          title: 'second',
          dependsOn: [] as string[]
        },
        {
          ...SPEC.tasks[0],
          id: 'T-03',
          title: 'blocked',
          dependsOn: ['T-02']
        }
      ]
    });
    stateLoad.mockReturnValue(loaded);

    handler.showStatus({ runsDir: '/runs', runId: 'run-1' });
    const output = (console.log as jest.Mock).mock.calls
      .map(call => String(call[0]))
      .join('\n');
    expect(output).toContain('T-01 merged');
    expect(output).toContain('T-02 halted-escalated');
    expect(output).toContain('T-03 blocked-by-dependency');
  });

  it('dispatches record-merge to the chronicle service, task ID included', async () => {
    await handler.recordMerge({
      chronicleRepo: '/chronicle',
      runsDir: '/runs',
      runId: 'run-1',
      mergedSha: 'abc123def456',
      taskId: 'T-01'
    });

    expect(recordMerge).toHaveBeenCalledWith({
      chronicleRepo: '/chronicle',
      runsDir: '/runs',
      runId: 'run-1',
      mergedSha: 'abc123def456',
      taskId: 'T-01'
    });
  });

  it('record-merge schedules fire-and-forget worktree cleanup when both task and repo are given', async () => {
    await handler.recordMerge({
      chronicleRepo: '/chronicle',
      runsDir: '/runs',
      runId: 'run-1',
      mergedSha: 'abc123def456',
      taskId: 'T-01',
      repoPath: '/repo'
    });

    expect(removeWorktreeAsync).toHaveBeenCalledWith(
      '/repo',
      path.join('/runs', 'run-1', 'worktrees', 'T-01')
    );
  });

  it('record-merge does not attempt cleanup without a repoPath — there is no repo to run git in', async () => {
    await handler.recordMerge({
      chronicleRepo: '/chronicle',
      runsDir: '/runs',
      runId: 'run-1',
      mergedSha: 'abc123def456',
      taskId: 'T-01'
    });

    expect(removeWorktreeAsync).not.toHaveBeenCalled();
  });

  describe('queueRun / listQueue (T-02 durable launch queue)', () => {
    let queueRunsDir: string;

    beforeEach(() => {
      queueRunsDir = mkdtempSync(path.join(os.tmpdir(), 'sdlc-queue-run-'));
    });

    afterEach(() => {
      rmSync(queueRunsDir, { recursive: true, force: true });
    });

    it('writes a well-formed FIFO record capturing the run argv surface', () => {
      handler.queueRun({
        specPath: '/specs/a.md',
        repoPath: '/repo-a',
        runsDir: queueRunsDir,
        chronicleRepo: '/chronicle',
        maxParallel: 2,
        heartbeatSeconds: 15,
        operator: 'octocat'
      });

      const file = path.join(queueRunsDir, 'queue', '1.json');
      const record = JSON.parse(readFileSync(file, 'utf-8'));
      expect(record.specPath).toBe(path.resolve('/specs/a.md'));
      expect(record.repoPath).toBe(path.resolve('/repo-a'));
      expect(record.argv).toEqual(
        expect.arrayContaining([
          'run',
          '--spec',
          path.resolve('/specs/a.md'),
          '--repo',
          path.resolve('/repo-a'),
          '--chronicle-repo',
          '/chronicle',
          '--max-parallel',
          '2',
          '--heartbeat',
          '15',
          '--operator',
          'octocat',
          '--supervise',
          '--detach'
        ])
      );
      expect(Array.isArray(record.execArgv)).toBe(true);
      expect(typeof record.execPath).toBe('string');
      expect(typeof record.cwd).toBe('string');
      expect(typeof record.queuedAt).toBe('string');
    });

    it('dedups a second queue-run for the same spec path', () => {
      handler.queueRun({
        specPath: '/specs/a.md',
        repoPath: '/repo-a',
        runsDir: queueRunsDir
      });
      handler.queueRun({
        specPath: '/specs/a.md',
        repoPath: '/repo-a',
        runsDir: queueRunsDir
      });
      handler.queueRun({
        specPath: '/specs/b.md',
        repoPath: '/repo-b',
        runsDir: queueRunsDir
      });

      const entries = new RunQueueRepository().list(queueRunsDir);
      expect(entries.map(entry => entry.record.specPath)).toEqual([
        path.resolve('/specs/a.md'),
        path.resolve('/specs/b.md')
      ]);
    });

    it('status --queue lists queued entries oldest first', () => {
      handler.queueRun({
        specPath: '/specs/a.md',
        repoPath: '/repo-a',
        runsDir: queueRunsDir
      });
      handler.queueRun({
        specPath: '/specs/b.md',
        repoPath: '/repo-b',
        runsDir: queueRunsDir
      });

      handler.listQueue({ runsDir: queueRunsDir });

      const output = (console.log as jest.Mock).mock.calls
        .map(call => String(call[0]))
        .join('\n');
      expect(output).toContain('Queued runs (2)');
      expect(output).toContain(path.resolve('/specs/a.md'));
      expect(output).toContain(path.resolve('/specs/b.md'));
      expect(output.indexOf(path.resolve('/specs/a.md'))).toBeLessThan(
        output.indexOf(path.resolve('/specs/b.md'))
      );
    });

    it('status --queue reports an empty queue', () => {
      handler.listQueue({ runsDir: queueRunsDir });
      const output = (console.log as jest.Mock).mock.calls
        .map(call => String(call[0]))
        .join('\n');
      expect(output).toContain('Queued runs (0)');
      expect(output).toContain('(empty)');
    });
  });
});
