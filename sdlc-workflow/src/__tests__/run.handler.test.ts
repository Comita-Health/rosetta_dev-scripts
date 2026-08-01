import 'reflect-metadata';
import { Container } from 'inversify';
import { IRunHandler, RunHandler } from '../handlers/run.handler';
import type { IEvidenceRepository } from '../repositories/evidence.repository';
import type { IGitRepository } from '../repositories/git.repository';
import type { IRunStateRepository } from '../repositories/run-state.repository';
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
import type { IReviewerGateService } from '../services/reviewer-gate.service';
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

  const taskOutcome = (
    overrides: Partial<ExecutorOutcome> = {}
  ): ExecutorOutcome => ({
    kind: 'completed',
    task: SPEC.tasks[0],
    branch: 'sdlc/run-1/T-01',
    cached: false,
    implDigest: 'impl-digest',
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
      .bind<IPrLifecycleService>(WORKFLOW_TOKENS.PrLifecycleService)
      .toConstantValue({ openTaskPr });
    container
      .bind<IPullRequestRepository>(WORKFLOW_TOKENS.PullRequestRepository)
      .toConstantValue({
        findByBranch: jest.fn(),
        create: jest.fn(),
        merge: prMerge
      });
    container
      .bind<ISandboxDeployService>(WORKFLOW_TOKENS.SandboxDeployService)
      .toConstantValue({ deploy });
    container
      .bind<IVerificationService>(WORKFLOW_TOKENS.VerificationService)
      .toConstantValue({ verify });
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
      .toConstantValue({ record: chronicleRecord, recordMerge });
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
        push: jest.fn()
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

    expect(deploy).toHaveBeenCalledWith({
      worktreePath: '/runs/run-1/worktrees/T-01',
      sha: 'head-sha',
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

    it('auto-merges the PR when all four gates are green, recording the SHA in state and Chronicle', async () => {
      greenGates();

      await handler.runTask({ ...INPUT, chronicleRepo: '/chronicle' });

      expect(prMerge).toHaveBeenCalledWith('/repo', 7);
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
    expect(output).toContain('T-01 completed on sdlc/run-1/T-01');
    expect(output).toContain('T-01 implementation');
    expect(output).toContain('T-01 envelope → pass');
    expect(output).toContain('reviewer-disagreement');
    expect(output).toContain('head-sha healthy');
    expect(output).toContain('merged: abc123');
  });

  it('shows placeholders for a fresh run and throws for an unknown one', () => {
    stateLoad.mockReturnValue(makeState());
    handler.showStatus({ runsDir: '/runs', runId: 'run-1' });
    const output = (console.log as jest.Mock).mock.calls
      .map(call => String(call[0]))
      .join('\n');
    expect(output).toContain('(none attempted)');
    expect(output).toContain('(none completed)');
    expect(output).toContain('(none recorded)');

    stateLoad.mockReturnValue(null);
    expect(() =>
      handler.showStatus({ runsDir: '/runs', runId: 'run-x' })
    ).toThrow(WorkflowError);
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
