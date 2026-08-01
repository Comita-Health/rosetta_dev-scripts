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
import type {
  ExecutorOutcome,
  IExecutorService
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
  runsDir: '/runs'
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

describe('RunHandler (shadow-mode single-task loop)', () => {
  let handler: IRunHandler;
  let state: RunState;
  let executeNext: jest.Mock;
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

  const completedOutcome = (): ExecutorOutcome => ({
    kind: 'completed',
    spec: SPEC,
    state,
    task: SPEC.tasks[0],
    branch: 'sdlc/run-1/T-01',
    implDigest: 'impl-digest'
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

    executeNext = jest.fn().mockImplementation(async () => completedOutcome());
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

    const container = new Container();
    container
      .bind<IExecutorService>(WORKFLOW_TOKENS.ExecutorService)
      .toConstantValue({ executeNext });
    container
      .bind<IEnvelopeGateService>(WORKFLOW_TOKENS.EnvelopeGateService)
      .toConstantValue({ evaluate });
    container
      .bind<IReviewerGateService>(WORKFLOW_TOKENS.ReviewerGateService)
      .toConstantValue({ review });
    container
      .bind<ISandboxDeployService>(WORKFLOW_TOKENS.SandboxDeployService)
      .toConstantValue({ deploy });
    container
      .bind<IVerificationService>(WORKFLOW_TOKENS.VerificationService)
      .toConstantValue({ verify });
    container
      .bind<ICiGateService>(WORKFLOW_TOKENS.CiGateService)
      .toConstantValue({ evaluate: ciEvaluate });
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
        diffText: jest.fn()
      });
    container
      .bind<IRunStateRepository>(WORKFLOW_TOKENS.RunStateRepository)
      .toConstantValue({
        appendVerdict,
        recordExceptions,
        recordSandbox,
        recordCriteria,
        recordStep,
        recordMergedSha: jest.fn(),
        load: jest.fn(),
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
      outcome: 'completed',
      taskId: 'T-01',
      branch: 'sdlc/run-1/T-01'
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

    expect(result.outcome).toBe('completed');
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

    expect(ciEvaluate).toHaveBeenCalledWith({
      repoPath: '/repo',
      sha: 'head-sha',
      taskId: 'T-01'
    });
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
    executeNext.mockResolvedValue({
      kind: 'blocked',
      spec: SPEC,
      state,
      detail: 'unapproved-spec'
    });

    const result = await handler.runTask(INPUT);

    expect(result.outcome).toBe('blocked');
    expect(evaluate).not.toHaveBeenCalled();
    expect(review).not.toHaveBeenCalled();
    expect(appendVerdict).not.toHaveBeenCalled();
  });

  it('reports no-ready-task without gate evaluation', async () => {
    executeNext.mockResolvedValue({
      kind: 'no-ready-task',
      spec: SPEC,
      state: null
    });

    const result = await handler.runTask(INPUT);

    expect(result.outcome).toBe('no-ready-task');
    expect(evaluate).not.toHaveBeenCalled();
  });

  it('throws on an incomplete executor outcome (contract violation)', async () => {
    executeNext.mockResolvedValue({
      kind: 'completed',
      spec: SPEC,
      state
      // task, branch and implDigest missing — violates the contract
    });

    await expect(handler.runTask(INPUT)).rejects.toThrow(
      'executor returned an incomplete outcome'
    );
  });

  it('still runs all gates on a failed task branch', async () => {
    executeNext.mockImplementation(async () => ({
      ...completedOutcome(),
      kind: 'failed' as const,
      detail: 'agent exploded'
    }));

    const result = await handler.runTask(INPUT);

    expect(result.outcome).toBe('failed');
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(review).toHaveBeenCalledTimes(1);
    expect(deploy).toHaveBeenCalledTimes(1);
    expect(appendVerdict).toHaveBeenCalledTimes(6);
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
    expect(posted.exceptions).toEqual([
      expect.objectContaining({ trigger: 'envelope-breach' })
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

    expect(result.outcome).toBe('completed');
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(review).toHaveBeenCalledTimes(1);
    expect(deploy).toHaveBeenCalledTimes(2); // first call was the kill
    expect(verify).toHaveBeenCalledTimes(1);
    expect(aggregate).toHaveBeenCalledTimes(1);
  });

  it('dispatches record-merge to the chronicle service', async () => {
    await handler.recordMerge({
      chronicleRepo: '/chronicle',
      runsDir: '/runs',
      runId: 'run-1',
      mergedSha: 'abc123def456'
    });

    expect(recordMerge).toHaveBeenCalledWith({
      chronicleRepo: '/chronicle',
      runsDir: '/runs',
      runId: 'run-1',
      mergedSha: 'abc123def456'
    });
  });
});
