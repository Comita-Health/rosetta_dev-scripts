import 'reflect-metadata';
import { Container } from 'inversify';
import { IRunHandler, RunHandler } from '../handlers/run.handler';
import type { IRunStateRepository } from '../repositories/run-state.repository';
import type { IAggregatorService } from '../services/aggregator.service';
import type { IEnvelopeGateService } from '../services/envelope-gate.service';
import type {
  ExecutorOutcome,
  IExecutorService
} from '../services/executor.service';
import type { IGitRepository } from '../repositories/git.repository';
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

const STATE: RunState = {
  runId: 'run-1',
  specId: SPEC.id,
  specPath: '/specs/spec.md',
  baseSha: 'base-sha',
  taskResults: {},
  verdicts: [],
  exceptions: [],
  criterionVerdicts: [],
  tokenSpendK: 0,
  ciFixAttempts: {},
  updatedAt: 'x'
};

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
  let executeNext: jest.Mock;
  let evaluate: jest.Mock;
  let review: jest.Mock;
  let deploy: jest.Mock;
  let verify: jest.Mock;
  let aggregate: jest.Mock;
  let appendVerdict: jest.Mock;
  let recordExceptions: jest.Mock;
  let recordSandbox: jest.Mock;
  let recordCriteria: jest.Mock;

  const completedOutcome = (): ExecutorOutcome => ({
    kind: 'completed',
    spec: SPEC,
    state: { ...STATE },
    task: SPEC.tasks[0],
    branch: 'sdlc/run-1/T-01'
  });

  const breachVerdict = verdictOf('envelope', 'breach', [
    'outside allowedPaths: infra/x.yml'
  ]);
  const reviewerVerdict = verdictOf('reviewer', 'pass', ['looks solid']);
  const sandboxVerdict = verdictOf('sandbox', 'pass', [
    'deployed and healthy at head-sha'
  ]);
  const verificationVerdict = verdictOf('verification', 'pass');
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
  const phaseVerdict = verdictOf('phase', 'breach', [
    'failing gates: ci, envelope'
  ]);

  beforeEach(() => {
    executeNext = jest.fn().mockResolvedValue(completedOutcome());
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
    appendVerdict = jest.fn();
    recordExceptions = jest.fn();
    recordSandbox = jest.fn();
    recordCriteria = jest.fn();

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
      .bind<IAggregatorService>(WORKFLOW_TOKENS.AggregatorService)
      .toConstantValue({ aggregate });
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
    // envelope, reviewer, sandbox, verification, phase
    expect(appendVerdict).toHaveBeenCalledTimes(5);
    for (const verdict of [
      breachVerdict,
      reviewerVerdict,
      sandboxVerdict,
      verificationVerdict,
      phaseVerdict
    ]) {
      expect(appendVerdict).toHaveBeenCalledWith(
        '/runs',
        expect.anything(),
        verdict
      );
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

  it('feeds real envelope/reviewer/verification verdicts to the aggregator with pending ci', async () => {
    await handler.runTask(INPUT);

    const call = aggregate.mock.calls[0][0];
    expect(call.gates.envelope).toBe(breachVerdict);
    expect(call.gates.reviewer).toBe(reviewerVerdict);
    expect(call.gates.verification).toBe(verificationVerdict);
    expect(call.gates.ci.outcome).toBe('blocked');
    expect(call.taskId).toBe('T-01');
    expect(call.budgetK).toBe(SPEC.envelope.budgetK);
  });

  it('halts at intake for a blocked run without evaluating gates', async () => {
    executeNext.mockResolvedValue({
      kind: 'blocked',
      spec: SPEC,
      state: STATE,
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
      state: STATE
      // task and branch missing — violates the executor contract
    });

    await expect(handler.runTask(INPUT)).rejects.toThrow(
      'executor returned an incomplete outcome'
    );
  });

  it('still runs all gates on a failed task branch', async () => {
    executeNext.mockResolvedValue({
      ...completedOutcome(),
      kind: 'failed',
      detail: 'agent exploded'
    });

    const result = await handler.runTask(INPUT);

    expect(result.outcome).toBe('failed');
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(review).toHaveBeenCalledTimes(1);
    expect(deploy).toHaveBeenCalledTimes(1);
    expect(appendVerdict).toHaveBeenCalledTimes(5);
  });
});
