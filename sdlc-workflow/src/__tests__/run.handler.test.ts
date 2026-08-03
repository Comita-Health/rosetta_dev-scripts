import 'reflect-metadata';
import { Container } from 'inversify';
import { IRunHandler, RunHandler } from '../handlers/run.handler';
import type { IEvidenceRepository } from '../repositories/evidence.repository';
import type { IGitRepository } from '../repositories/git.repository';
import type { IQueueRepository } from '../repositories/queue.repository';
import type { IRunStateRepository } from '../repositories/run-state.repository';
import type { ISpecDocRepository } from '../repositories/spec-doc.repository';
import type { IEscalationService } from '../services/escalation.service';
import type { IAggregatorService } from '../services/aggregator.service';
import type { IChronicleCommitService } from '../services/chronicle-commit.service';
import type { ICiGateService } from '../services/ci-gate.service';
import type { IDigestService } from '../services/digest.service';
import type { IEnvelopeGateService } from '../services/envelope-gate.service';
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
import type { IVerificationService } from '../services/verification.service';
import { WORKFLOW_TOKENS } from '../tokens';
import { GateVerdict, RunState, SpecDocument, WorkflowError } from '../types';
import { makeEnvelope, makeTask } from './fixtures';

const SPEC: SpecDocument = {
  id: 'SPEC-PRD-0099-P2',
  prdId: 'PRD-0099',
  phase: 2,
  status: 'Approved',
  envelope: makeEnvelope(),
  tasks: [makeTask()]
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
  updatedAt: 'x'
});

const INPUT = {
  specPath: '/specs/spec.md',
  repoPath: '/repo',
  runId: 'run-1',
  runsDir: '/runs',
  maxParallel: 3
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
  let chronicleRecord: jest.Mock;
  let recordMerge: jest.Mock;
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
  let recordRevert: jest.Mock;
  let itemTags: jest.Mock;
  let revertMerge: jest.Mock;
  let prCreate: jest.Mock;
  let gitPush: jest.Mock;
  let gitFetch: jest.Mock;
  let specRead: jest.Mock;
  let escalationPost: jest.Mock;

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
    chronicleRecord = jest.fn().mockResolvedValue({ artifactPaths: ['a'] });
    recordMerge = jest
      .fn()
      .mockResolvedValue('chronicles/sdlc/run-1/merge.json');
    evidenceSave = jest.fn().mockReturnValue('/evidence/x.txt');

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
    recordRevert = jest.fn().mockResolvedValue('chronicles/sdlc/run-1/revert');
    itemTags = jest.fn().mockReturnValue(null);
    revertMerge = jest.fn();
    gitPush = jest.fn();
    gitFetch = jest.fn();
    prCreate = jest.fn().mockReturnValue({
      url: 'https://github.com/org/repo/pull/99',
      number: 99
    });
    specRead = jest.fn().mockReturnValue(SPEC);
    escalationPost = jest.fn().mockReturnValue({ posted: [], issueUrls: [] });

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
        comment: jest.fn()
      });
    container
      .bind<IQueueRepository>(WORKFLOW_TOKENS.QueueRepository)
      .toConstantValue({ appendItem: jest.fn(), itemTags });
    container
      .bind<IEscalationService>(WORKFLOW_TOKENS.EscalationService)
      .toConstantValue({ post: escalationPost });
    container
      .bind<ISpecDocRepository>(WORKFLOW_TOKENS.SpecDocRepository)
      .toConstantValue({ read: specRead });
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
      .bind<IChronicleCommitService>(WORKFLOW_TOKENS.ChronicleCommitService)
      .toConstantValue({ record: chronicleRecord, recordMerge, recordRevert });
    container
      .bind<IEvidenceRepository>(WORKFLOW_TOKENS.EvidenceRepository)
      .toConstantValue({ save: evidenceSave, load: jest.fn() });
    container
      .bind<IGitRepository>(WORKFLOW_TOKENS.GitRepository)
      .toConstantValue({
        headSha: jest.fn().mockReturnValue('head-sha'),
        status: jest.fn(),
        addWorktree: jest.fn(),
        diffStat: jest.fn(),
        diffText: jest.fn(),
        push: gitPush,
        fetch: gitFetch,
        resolveSha: jest.fn().mockReturnValue('main-sha'),
        defaultBranch: jest.fn().mockReturnValue('main'),
        fileAtRef: jest.fn().mockReturnValue(null),
        pathDiffersFromRef: jest.fn().mockReturnValue(false),
        revertMerge,
        stageAll: jest.fn(),
        commit: jest.fn()
      });
    container
      .bind<IHeartbeatService>(WORKFLOW_TOKENS.HeartbeatService)
      .toConstantValue({
        start: jest.fn(),
        setContext: jest.fn(),
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
        load: stateLoad,
        save: jest.fn(),
        recordTaskResult: jest.fn()
      });
    container.bind<IRunHandler>(WORKFLOW_TOKENS.RunHandler).to(RunHandler);
    handler = container.get<IRunHandler>(WORKFLOW_TOKENS.RunHandler);
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    (console.log as jest.Mock).mockRestore();
  });

  it('persists all gate verdicts and exceptions, proceeding unblocked on breaches', async () => {
    const result = await handler.runTask(INPUT);

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
    await handler.runTask(INPUT);

    // P4 T-01: baseSha is the same integration tip the envelope and reviewer
    // gates diff against, so a repo-owned script sees the task's own change
    // set rather than everything since the run started.
    expect(deploy).toHaveBeenCalledWith({
      worktreePath: '/runs/run-1/worktrees/T-01',
      sha: 'head-sha',
      baseSha: 'base-sha',
      previous: undefined
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

  it('records a blocked verification verdict when criterion validation fails, without crashing the run', async () => {
    verify.mockRejectedValue(
      new WorkflowError('bad criterion prefix', 'SPEC_MALFORMED')
    );

    const result = await handler.runTask(INPUT);

    expect(result.outcome).toBe('executed');
    const call = aggregate.mock.calls[0][0];
    expect(call.gates.verification.outcome).toBe('blocked');
    expect(call.gates.verification.reasons).toEqual(['bad criterion prefix']);
    expect(recordCriteria).toHaveBeenCalledWith('/runs', expect.anything(), []);
  });

  it('rethrows unexpected verification errors', async () => {
    verify.mockRejectedValue(new Error('disk on fire'));

    await expect(handler.runTask(INPUT)).rejects.toThrow('disk on fire');
  });

  it('feeds real envelope/reviewer/verification/ci verdicts to the aggregator', async () => {
    await handler.runTask(INPUT);

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

    const result = await handler.runTask(INPUT);

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

  it('records a blocked pr verdict on push/PR failure, keeps state intact, and retries on the next run (P3 T-02)', async () => {
    openTaskPr.mockImplementationOnce(() => {
      throw new WorkflowError('gh pr failed', 'GH_FAILED', ['boom']);
    });

    const result = await handler.runTask(INPUT);

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

    await handler.runTask(INPUT);
    expect(openTaskPr).toHaveBeenCalledTimes(2);
    expect(recordTaskPrUrl).toHaveBeenCalledTimes(1);
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

      await handler.runTask(INPUT);

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

      const result = await handler.runTask(INPUT);

      expect(result.outcome).toBe('executed');
      expect(state.exceptions).toContainEqual(
        expect.objectContaining({
          trigger: 'merge-blocked',
          context: [expect.stringContaining('merge conflict')]
        })
      );
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
      expect(calls[0][0]).toEqual(expect.objectContaining({ sha: 'main-sha' }));
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

  it('skips digest and chronicle steps without --chronicle-repo', async () => {
    await handler.runTask(INPUT);

    expect(digestPost).not.toHaveBeenCalled();
    expect(chronicleRecord).not.toHaveBeenCalled();
  });

  it('posts exactly one digest and commits artifacts when a chronicle repo is given (T-07/T-08)', async () => {
    await handler.runTask({ ...INPUT, chronicleRepo: '/chronicle' });

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
    // Enforcing mode adds the merge-blocked escalation for the red phase.
    expect(posted.exceptions).toEqual([
      expect.objectContaining({ trigger: 'envelope-breach' }),
      expect.objectContaining({ trigger: 'merge-blocked' })
    ]);
  });

  it('kill-resume at any boundary produces no duplicate side effects (T-09)', async () => {
    const chronicleInput = { ...INPUT, chronicleRepo: '/chronicle' };
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
    // First pass killed after the reviewer gate: run with sandbox deploy
    // failing hard to stop the pipeline there.
    deploy.mockRejectedValueOnce(new Error('killed'));
    await expect(handler.runTask(INPUT)).rejects.toThrow('killed');
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(review).toHaveBeenCalledTimes(1);

    // Resume: envelope and reviewer verdicts come from the step cache;
    // the remaining steps execute exactly once.
    deploy.mockResolvedValue({
      verdict: sandboxVerdict,
      record: { sha: 'head-sha', status: 'healthy', recordedAt: 'x' },
      healthReport: 'sha=head-sha ok'
    });
    const result = await handler.runTask(INPUT);

    expect(result.outcome).toBe('executed');
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(review).toHaveBeenCalledTimes(1);
    expect(deploy).toHaveBeenCalledTimes(2); // first call was the kill
    expect(verify).toHaveBeenCalledTimes(1);
    expect(aggregate).toHaveBeenCalledTimes(1);
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
});
