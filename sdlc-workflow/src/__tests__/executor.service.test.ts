import 'reflect-metadata';
import { Container } from 'inversify';
import path from 'path';
import type { IAgentRunnerRepository } from '../repositories/agent-runner.repository';
import type { IGitRepository } from '../repositories/git.repository';
import type { IRunStateRepository } from '../repositories/run-state.repository';
import type { ISpecDocRepository } from '../repositories/spec-doc.repository';
import {
  ExecutorService,
  IExecutorService,
  implementationDigest,
  taskBranch
} from '../services/executor.service';
import { WORKFLOW_TOKENS } from '../tokens';
import { RunState, SpecDocument, stepKey } from '../types';
import { makeEnvelope, makeTask } from './fixtures';

const makeSpec = (overrides: Partial<SpecDocument> = {}): SpecDocument => ({
  id: 'SPEC-PRD-0099-P2',
  prdId: 'PRD-0099',
  phase: 2,
  status: 'Approved',
  envelope: makeEnvelope(),
  tasks: [makeTask(), makeTask({ id: 'T-02', dependsOn: ['T-01'] })],
  ...overrides
});

const INPUT = {
  specPath: '/specs/spec.md',
  repoPath: '/repo',
  runId: 'run-1',
  runsDir: '/runs'
};

describe('ExecutorService (T-01)', () => {
  let executor: IExecutorService;
  let specRead: jest.Mock;
  let gitMock: jest.Mocked<IGitRepository>;
  let agentRun: jest.Mock;
  let stateMock: jest.Mocked<IRunStateRepository>;

  beforeEach(() => {
    specRead = jest.fn().mockReturnValue(makeSpec());
    gitMock = {
      headSha: jest.fn().mockReturnValue('base-sha'),
      status: jest.fn().mockReturnValue(''),
      addWorktree: jest.fn(),
      diffStat: jest.fn(),
      diffText: jest.fn()
    };
    agentRun = jest.fn().mockResolvedValue({ ok: true, output: 'done' });
    stateMock = {
      load: jest.fn().mockReturnValue(null),
      save: jest.fn(),
      appendVerdict: jest.fn(),
      recordTaskResult: jest.fn(),
      recordExceptions: jest.fn(),
      recordSandbox: jest.fn(),
      recordCriteria: jest.fn(),
      recordStep: jest.fn(),
      recordMergedSha: jest.fn()
    };

    const container = new Container();
    container
      .bind<ISpecDocRepository>(WORKFLOW_TOKENS.SpecDocRepository)
      .toConstantValue({ read: specRead });
    container
      .bind<IGitRepository>(WORKFLOW_TOKENS.GitRepository)
      .toConstantValue(gitMock);
    container
      .bind<IAgentRunnerRepository>(WORKFLOW_TOKENS.AgentRunnerRepository)
      .toConstantValue({ run: agentRun });
    container
      .bind<IRunStateRepository>(WORKFLOW_TOKENS.RunStateRepository)
      .toConstantValue(stateMock);
    container
      .bind<IExecutorService>(WORKFLOW_TOKENS.ExecutorService)
      .to(ExecutorService);
    executor = container.get<IExecutorService>(WORKFLOW_TOKENS.ExecutorService);
  });

  it('refuses an unapproved spec and records a blocked verdict', async () => {
    specRead.mockReturnValue(makeSpec({ status: 'Draft' }));

    const outcome = await executor.executeNext(INPUT);

    expect(outcome.kind).toBe('blocked');
    expect(outcome.detail).toBe('unapproved-spec');
    expect(stateMock.appendVerdict).toHaveBeenCalledWith(
      '/runs',
      expect.anything(),
      expect.objectContaining({
        gate: 'intake',
        outcome: 'blocked',
        wouldEscalate: true,
        reasons: ['unapproved-spec']
      })
    );
    expect(agentRun).not.toHaveBeenCalled();
    expect(gitMock.addWorktree).not.toHaveBeenCalled();
  });

  it('selects exactly one ready task (dependsOn satisfied)', async () => {
    const outcome = await executor.executeNext(INPUT);

    expect(outcome.kind).toBe('completed');
    expect(outcome.task?.id).toBe('T-01'); // T-02 depends on T-01
    expect(agentRun).toHaveBeenCalledTimes(1);
  });

  it('selects the next task once its dependencies are completed', async () => {
    const existing: RunState = {
      runId: 'run-1',
      specId: 'SPEC-PRD-0099-P2',
      specPath: INPUT.specPath,
      baseSha: 'base-sha',
      taskResults: {
        'T-01': {
          taskId: 'T-01',
          status: 'completed',
          recordedAt: 'x'
        }
      },
      verdicts: [],
      exceptions: [],
      criterionVerdicts: [],
      steps: {},
      tokenSpendK: 0,
      ciFixAttempts: {},
      updatedAt: 'x'
    };
    stateMock.load.mockReturnValue(existing);

    const outcome = await executor.executeNext(INPUT);
    expect(outcome.task?.id).toBe('T-02');
  });

  it('reports no-ready-task without side effects when none qualify', async () => {
    const existing: RunState = {
      runId: 'run-1',
      specId: 'SPEC-PRD-0099-P2',
      specPath: INPUT.specPath,
      baseSha: 'base-sha',
      taskResults: {
        'T-01': { taskId: 'T-01', status: 'failed', recordedAt: 'x' }
      },
      verdicts: [],
      exceptions: [],
      criterionVerdicts: [],
      steps: {},
      tokenSpendK: 0,
      ciFixAttempts: {},
      updatedAt: 'x'
    };
    stateMock.load.mockReturnValue(existing);

    const outcome = await executor.executeNext(INPUT);

    // T-01 already attempted (failed), T-02's dependency is unmet.
    expect(outcome.kind).toBe('no-ready-task');
    expect(stateMock.save).not.toHaveBeenCalled();
    expect(stateMock.recordTaskResult).not.toHaveBeenCalled();
    expect(agentRun).not.toHaveBeenCalled();
    expect(gitMock.addWorktree).not.toHaveBeenCalled();
  });

  it('runs the agent in a worktree on a deterministic branch', async () => {
    await executor.executeNext(INPUT);

    const expectedBranch = taskBranch('run-1', 'T-01');
    expect(expectedBranch).toBe('sdlc/run-1/T-01');
    const expectedWorktree = path.join('/runs', 'run-1', 'worktrees', 'T-01');
    expect(gitMock.addWorktree).toHaveBeenCalledWith(
      '/repo',
      expectedWorktree,
      expectedBranch,
      'base-sha'
    );
    // The agent works in the worktree, never the primary checkout.
    expect(agentRun.mock.calls[0][0]).toBe(expectedWorktree);
    expect(agentRun.mock.calls[0][1]).toContain('T-01');
    expect(agentRun.mock.calls[0][1]).toContain('Blast-radius envelope');
  });

  it('records a failure result instead of throwing when the agent fails', async () => {
    agentRun.mockResolvedValue({ ok: false, output: 'agent exploded' });

    const outcome = await executor.executeNext(INPUT);

    expect(outcome.kind).toBe('failed');
    expect(stateMock.recordTaskResult).toHaveBeenCalledWith(
      '/runs',
      expect.anything(),
      expect.objectContaining({
        taskId: 'T-01',
        status: 'failed',
        branch: 'sdlc/run-1/T-01',
        detail: 'agent exploded'
      })
    );
  });

  it('records a failure result when the agent runner throws', async () => {
    agentRun.mockRejectedValue(new Error('spawn refused'));

    const outcome = await executor.executeNext(INPUT);

    expect(outcome.kind).toBe('failed');
    expect(outcome.detail).toBe('spawn refused');
  });

  describe('T-09 step cache', () => {
    const baseState = (): RunState => ({
      runId: 'run-1',
      specId: 'SPEC-PRD-0099-P2',
      specPath: INPUT.specPath,
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

    it('records the implementation step on success', async () => {
      await executor.executeNext(INPUT);

      const digest = implementationDigest(makeSpec().tasks[0], 'base-sha');
      expect(stateMock.recordStep).toHaveBeenCalledWith(
        '/runs',
        expect.anything(),
        stepKey('implementation', 'T-01', digest),
        expect.objectContaining({
          name: 'implementation',
          taskId: 'T-01',
          inputsDigest: digest
        })
      );
    });

    it('does not record a step for a failed implementation', async () => {
      agentRun.mockResolvedValue({ ok: false, output: 'boom' });

      await executor.executeNext(INPUT);

      expect(stateMock.recordStep).not.toHaveBeenCalled();
    });

    it('reuses a cached implementation without re-invoking the agent (kill-resume)', async () => {
      const task = makeSpec().tasks[0];
      const digest = implementationDigest(task, 'base-sha');
      const state = baseState();
      state.taskResults['T-01'] = {
        taskId: 'T-01',
        status: 'completed',
        branch: 'sdlc/run-1/T-01',
        inputsDigest: digest,
        recordedAt: 'x'
      };
      state.steps[stepKey('implementation', 'T-01', digest)] = {
        name: 'implementation',
        taskId: 'T-01',
        inputsDigest: digest,
        completedAt: 'x'
      };
      stateMock.load.mockReturnValue(state);

      const outcome = await executor.executeNext(INPUT);

      expect(outcome.kind).toBe('completed');
      expect(outcome.cached).toBe(true);
      expect(outcome.task?.id).toBe('T-01');
      expect(outcome.branch).toBe('sdlc/run-1/T-01');
      expect(agentRun).not.toHaveBeenCalled();
      expect(gitMock.addWorktree).not.toHaveBeenCalled();
    });

    it('skips a task whose phase verdict landed and picks the next one', async () => {
      const task = makeSpec().tasks[0];
      const digest = implementationDigest(task, 'base-sha');
      const state = baseState();
      state.taskResults['T-01'] = {
        taskId: 'T-01',
        status: 'completed',
        branch: 'sdlc/run-1/T-01',
        inputsDigest: digest,
        recordedAt: 'x'
      };
      state.steps[stepKey('implementation', 'T-01', digest)] = {
        name: 'implementation',
        taskId: 'T-01',
        inputsDigest: digest,
        completedAt: 'x'
      };
      state.steps[stepKey('phase', 'T-01', 'phase-digest')] = {
        name: 'phase',
        taskId: 'T-01',
        inputsDigest: 'phase-digest',
        completedAt: 'x'
      };
      stateMock.load.mockReturnValue(state);

      const outcome = await executor.executeNext(INPUT);

      expect(outcome.task?.id).toBe('T-02');
      expect(agentRun).toHaveBeenCalledTimes(1);
    });

    it('re-runs a task whose spec content changed, leaving other tasks cached (invalidation)', async () => {
      const state = baseState();
      // T-01 completed under *old* content: its recorded digest no longer
      // matches the digest of the current task content.
      state.taskResults['T-01'] = {
        taskId: 'T-01',
        status: 'completed',
        branch: 'sdlc/run-1/T-01',
        inputsDigest: 'old-content-digest',
        recordedAt: 'x'
      };
      state.steps[stepKey('implementation', 'T-01', 'old-content-digest')] = {
        name: 'implementation',
        taskId: 'T-01',
        inputsDigest: 'old-content-digest',
        completedAt: 'x'
      };
      state.steps[stepKey('phase', 'T-01', 'old-phase-digest')] = {
        name: 'phase',
        taskId: 'T-01',
        inputsDigest: 'old-phase-digest',
        completedAt: 'x'
      };
      // A cached step belonging to another task must survive untouched.
      const otherKey = stepKey('implementation', 'T-02', 'other-digest');
      state.steps[otherKey] = {
        name: 'implementation',
        taskId: 'T-02',
        inputsDigest: 'other-digest',
        completedAt: 'x'
      };
      stateMock.load.mockReturnValue(state);

      const outcome = await executor.executeNext(INPUT);

      // The edited task is re-selected and the agent re-invoked.
      expect(outcome.task?.id).toBe('T-01');
      expect(outcome.cached).toBe(false);
      expect(agentRun).toHaveBeenCalledTimes(1);
      // Only T-01's chain is invalidated: T-02's cached step is untouched.
      expect(state.steps[otherKey]).toBeDefined();
    });

    it('does not retry a failed attempt at unchanged content', async () => {
      const spec = makeSpec();
      const digest = implementationDigest(spec.tasks[0], 'base-sha');
      const state = baseState();
      state.taskResults['T-01'] = {
        taskId: 'T-01',
        status: 'failed',
        inputsDigest: digest,
        recordedAt: 'x'
      };
      stateMock.load.mockReturnValue(state);

      const outcome = await executor.executeNext(INPUT);

      expect(outcome.kind).toBe('no-ready-task');
      expect(agentRun).not.toHaveBeenCalled();
    });

    it('retries a failed attempt once the content changed', async () => {
      const state = baseState();
      state.taskResults['T-01'] = {
        taskId: 'T-01',
        status: 'failed',
        inputsDigest: 'old-content-digest',
        recordedAt: 'x'
      };
      stateMock.load.mockReturnValue(state);

      const outcome = await executor.executeNext(INPUT);

      expect(outcome.task?.id).toBe('T-01');
      expect(agentRun).toHaveBeenCalledTimes(1);
    });
  });
});
