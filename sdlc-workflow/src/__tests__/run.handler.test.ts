import 'reflect-metadata';
import { Container } from 'inversify';
import { IRunHandler, RunHandler } from '../handlers/run.handler';
import type { IRunStateRepository } from '../repositories/run-state.repository';
import type { IEnvelopeGateService } from '../services/envelope-gate.service';
import type {
  ExecutorOutcome,
  IExecutorService
} from '../services/executor.service';
import { WORKFLOW_TOKENS } from '../tokens';
import { GateVerdict, RunState, SpecDocument } from '../types';
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
  updatedAt: 'x'
};

const INPUT = {
  specPath: '/specs/spec.md',
  repoPath: '/repo',
  runId: 'run-1',
  runsDir: '/runs'
};

describe('RunHandler (shadow-mode single-task loop)', () => {
  let handler: IRunHandler;
  let executeNext: jest.Mock;
  let evaluate: jest.Mock;
  let appendVerdict: jest.Mock;

  const completedOutcome = (): ExecutorOutcome => ({
    kind: 'completed',
    spec: SPEC,
    state: { ...STATE },
    task: SPEC.tasks[0],
    branch: 'sdlc/run-1/T-01'
  });

  const breachVerdict: GateVerdict = {
    gate: 'envelope',
    outcome: 'breach',
    wouldEscalate: true,
    reasons: ['outside allowedPaths: infra/x.yml'],
    recordedAt: 'x'
  };

  beforeEach(() => {
    executeNext = jest.fn().mockResolvedValue(completedOutcome());
    evaluate = jest.fn().mockResolvedValue(breachVerdict);
    appendVerdict = jest.fn();

    const container = new Container();
    container
      .bind<IExecutorService>(WORKFLOW_TOKENS.ExecutorService)
      .toConstantValue({ executeNext });
    container
      .bind<IEnvelopeGateService>(WORKFLOW_TOKENS.EnvelopeGateService)
      .toConstantValue({ evaluate });
    container
      .bind<IRunStateRepository>(WORKFLOW_TOKENS.RunStateRepository)
      .toConstantValue({
        appendVerdict,
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

  it('persists a breach verdict with wouldEscalate and proceeds unblocked', async () => {
    const result = await handler.runTask(INPUT);

    // Shadow semantics: the breach is recorded, the run is not failed by it.
    expect(result).toEqual({
      outcome: 'completed',
      taskId: 'T-01',
      branch: 'sdlc/run-1/T-01'
    });
    expect(appendVerdict).toHaveBeenCalledWith(
      '/runs',
      expect.anything(),
      breachVerdict
    );
    expect(evaluate).toHaveBeenCalledWith({
      repoPath: '/repo',
      baseRef: 'base-sha',
      headRef: 'sdlc/run-1/T-01',
      envelope: SPEC.envelope
    });
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

  it('still runs the envelope gate on a failed task branch', async () => {
    executeNext.mockResolvedValue({
      ...completedOutcome(),
      kind: 'failed',
      detail: 'agent exploded'
    });

    const result = await handler.runTask(INPUT);

    expect(result.outcome).toBe('failed');
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(appendVerdict).toHaveBeenCalledTimes(1);
  });
});
