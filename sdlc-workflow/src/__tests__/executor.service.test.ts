import 'reflect-metadata';
import { Container } from 'inversify';
import path from 'path';
import type { IAgentRunnerRepository } from '../repositories/agent-runner.repository';
import type { IGitRepository } from '../repositories/git.repository';
import type { IRunStateRepository } from '../repositories/run-state.repository';
import type { ISpecDocRepository } from '../repositories/spec-doc.repository';
import type { ISurfaceMapRepository } from '../repositories/surface-map.repository';
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
  runsDir: '/runs',
  maxParallel: 3
};

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

describe('ExecutorService (P2 T-01 + P3 T-01 pool)', () => {
  let executor: IExecutorService;
  let specRead: jest.Mock;
  let surfaceLoad: jest.Mock;
  let gitMock: jest.Mocked<IGitRepository>;
  let agentRun: jest.Mock;
  let stateMock: jest.Mocked<IRunStateRepository>;

  beforeEach(() => {
    specRead = jest.fn().mockReturnValue(makeSpec());
    // The fixture envelope forbids 'ci-config'; the map must define it or
    // every task blocks at intake on an unresolvable surface label.
    surfaceLoad = jest
      .fn()
      .mockReturnValue({ 'ci-config': ['.github/workflows/**'] });
    gitMock = {
      // The primary checkout is at base-sha; a worktree the agent committed
      // in reports a new head (the no-commit guard compares the two).
      headSha: jest
        .fn()
        .mockImplementation((repoPath: string) =>
          repoPath.includes('worktrees') ? 'agent-sha' : 'base-sha'
        ),
      status: jest.fn().mockReturnValue(''),
      addWorktree: jest.fn(),
      diffStat: jest.fn(),
      diffText: jest.fn(),
      push: jest.fn(),
      fetch: jest.fn(),
      resolveSha: jest.fn(),
      defaultBranch: jest.fn(),
      revertMerge: jest.fn(),
      stageAll: jest.fn(),
      commit: jest.fn()
    };
    agentRun = jest.fn().mockResolvedValue({ ok: true, output: 'done' });
    stateMock = {
      load: jest.fn().mockReturnValue(null),
      save: jest.fn(),
      appendVerdict: jest.fn(),
      recordTaskResult: jest
        .fn()
        .mockImplementation((_d, state: RunState, result) => {
          state.taskResults[result.taskId] = result;
        }),
      recordExceptions: jest
        .fn()
        .mockImplementation((_d, state: RunState, entries) => {
          state.exceptions.push(...entries);
        }),
      recordSandbox: jest.fn(),
      recordCriteria: jest.fn(),
      recordStep: jest.fn(),
      recordMergedSha: jest.fn(),
      recordTaskMerged: jest.fn(),
      recordTaskPrUrl: jest.fn(),
      recordCiFixAttempt: jest.fn(),
      recordTokenSpend: jest
        .fn()
        .mockImplementation((_d, state: RunState, delta: number) => {
          state.tokenSpendK = (state.tokenSpendK ?? 0) + delta;
          return state.tokenSpendK;
        })
    };

    const container = new Container();
    container
      .bind<ISpecDocRepository>(WORKFLOW_TOKENS.SpecDocRepository)
      .toConstantValue({ read: specRead });
    container
      .bind<ISurfaceMapRepository>(WORKFLOW_TOKENS.SurfaceMapRepository)
      .toConstantValue({ load: surfaceLoad });
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

    const pool = await executor.executeReady(INPUT);

    expect(pool.kind).toBe('blocked');
    expect(pool.detail).toBe('unapproved-spec');
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

  // The envelope gate fails closed on a label it cannot resolve, so a
  // forbiddenSurfaces entry the repo never defined breaches every task no
  // matter what the diff contains. Catching it at intake costs nothing;
  // catching it at the gate costs a full wave of agent work first.
  it('blocks at intake on a forbiddenSurfaces label the repo does not define', async () => {
    specRead.mockReturnValue(
      makeSpec({
        envelope: makeEnvelope({
          forbiddenSurfaces: ['ci-config', 'migrations']
        })
      })
    );

    const pool = await executor.executeReady(INPUT);

    expect(pool.kind).toBe('blocked');
    expect(pool.detail).toBe('invalid-spec');
    expect(stateMock.appendVerdict).toHaveBeenCalledWith(
      '/runs',
      expect.anything(),
      expect.objectContaining({
        gate: 'intake',
        outcome: 'blocked',
        wouldEscalate: true,
        reasons: expect.arrayContaining([
          'invalid-spec',
          expect.stringContaining('migrations')
        ])
      })
    );
    // Nothing may be spent before the spec is known to be runnable.
    expect(agentRun).not.toHaveBeenCalled();
    expect(gitMock.addWorktree).not.toHaveBeenCalled();
  });

  it('reports the labels the repo does define, so the fix is obvious', async () => {
    specRead.mockReturnValue(
      makeSpec({ envelope: makeEnvelope({ forbiddenSurfaces: ['frontend'] }) })
    );

    await executor.executeReady(INPUT);

    const verdict = stateMock.appendVerdict.mock.calls[0][2];
    expect(verdict.reasons.join(' ')).toContain('defined: ci-config');
  });

  it('does not block when every forbidden label resolves', async () => {
    const pool = await executor.executeReady(INPUT);

    expect(pool.kind).not.toBe('blocked');
    expect(surfaceLoad).toHaveBeenCalledWith('/repo');
  });

  it('starts only tasks whose dependencies are merged', async () => {
    const pool = await executor.executeReady(INPUT);

    // T-02 depends on T-01, which is not merged: only T-01 starts.
    expect(pool.kind).toBe('executed');
    expect(pool.outcomes.map(o => o.task.id)).toEqual(['T-01']);
    expect(agentRun).toHaveBeenCalledTimes(1);
  });

  it('a completed but unmerged dependency does not unblock its dependents', async () => {
    const state = baseState();
    const digest = implementationDigest(makeSpec().tasks[0], 'base-sha');
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
    state.steps[stepKey('phase', 'T-01', 'p')] = {
      name: 'phase',
      taskId: 'T-01',
      inputsDigest: 'p',
      completedAt: 'x',
      verdict: {
        gate: 'phase',
        outcome: 'breach',
        wouldEscalate: true,
        reasons: ['failing gates: envelope'],
        recordedAt: 'x'
      }
    };
    stateMock.load.mockReturnValue(state);

    const pool = await executor.executeReady(INPUT);

    // T-01 phase breach + unmerged: T-02 stays ineligible; T-01 not retried.
    expect(pool.kind).toBe('no-ready-task');
    expect(agentRun).not.toHaveBeenCalled();
  });

  it('re-selects a green-phase unmerged task so enforce can retry merge', async () => {
    const state = baseState();
    const digest = implementationDigest(makeSpec().tasks[0], 'base-sha');
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
    state.steps[stepKey('phase', 'T-01', 'p')] = {
      name: 'phase',
      taskId: 'T-01',
      inputsDigest: 'p',
      completedAt: 'x',
      verdict: {
        gate: 'phase',
        outcome: 'pass',
        wouldEscalate: false,
        reasons: [],
        recordedAt: 'x'
      }
    };
    stateMock.load.mockReturnValue(state);

    const pool = await executor.executeReady(INPUT);

    expect(pool.kind).toBe('executed');
    expect(pool.outcomes[0].task.id).toBe('T-01');
    expect(pool.outcomes[0].cached).toBe(true);
    expect(agentRun).not.toHaveBeenCalled();
  });

  it('a merged dependency unblocks its dependents', async () => {
    const state = baseState();
    const digest = implementationDigest(makeSpec().tasks[0], 'base-sha');
    state.taskResults['T-01'] = {
      taskId: 'T-01',
      status: 'completed',
      branch: 'sdlc/run-1/T-01',
      inputsDigest: digest,
      mergedSha: 'merge-sha',
      recordedAt: 'x'
    };
    state.mergedSha = 'merge-sha';
    state.steps[stepKey('implementation', 'T-01', digest)] = {
      name: 'implementation',
      taskId: 'T-01',
      inputsDigest: digest,
      completedAt: 'x'
    };
    state.steps[stepKey('phase', 'T-01', 'p')] = {
      name: 'phase',
      taskId: 'T-01',
      inputsDigest: 'p',
      completedAt: 'x'
    };
    stateMock.load.mockReturnValue(state);

    const pool = await executor.executeReady(INPUT);

    expect(pool.outcomes.map(o => o.task.id)).toEqual(['T-02']);
    expect(agentRun).toHaveBeenCalledTimes(1);
  });

  it('branches a dependent from the post-merge tip and digests against that tip (#42)', async () => {
    const state = baseState();
    const t01 = makeSpec().tasks[0];
    const t02 = makeSpec().tasks[1];
    const t01Digest = implementationDigest(t01, 'base-sha');
    state.taskResults['T-01'] = {
      taskId: 'T-01',
      status: 'completed',
      branch: 'sdlc/run-1/T-01',
      inputsDigest: t01Digest,
      mergedSha: 'integration-tip',
      recordedAt: 'x'
    };
    state.mergedSha = 'integration-tip';
    state.steps[stepKey('implementation', 'T-01', t01Digest)] = {
      name: 'implementation',
      taskId: 'T-01',
      inputsDigest: t01Digest,
      completedAt: 'x'
    };
    state.steps[stepKey('phase', 'T-01', 'p')] = {
      name: 'phase',
      taskId: 'T-01',
      inputsDigest: 'p',
      completedAt: 'x'
    };
    stateMock.load.mockReturnValue(state);
    // Worktree head advances past the tip once the agent commits.
    gitMock.headSha.mockImplementation((repoPath: string) =>
      repoPath.includes('worktrees') ? 't02-commit' : 'base-sha'
    );

    const pool = await executor.executeReady(INPUT);

    const expectedTipDigest = implementationDigest(t02, 'integration-tip');
    const frozenDigest = implementationDigest(t02, 'base-sha');
    expect(expectedTipDigest).not.toBe(frozenDigest);
    expect(pool.outcomes[0].task.id).toBe('T-02');
    expect(pool.outcomes[0].baseSha).toBe('integration-tip');
    expect(pool.outcomes[0].implDigest).toBe(expectedTipDigest);
    expect(gitMock.addWorktree).toHaveBeenCalledWith(
      '/repo',
      path.join('/runs', 'run-1', 'worktrees', 'T-02'),
      'sdlc/run-1/T-02',
      'integration-tip'
    );
    expect(stateMock.recordStep).toHaveBeenCalledWith(
      '/runs',
      expect.anything(),
      stepKey('implementation', 'T-02', expectedTipDigest),
      expect.objectContaining({
        name: 'implementation',
        taskId: 'T-02',
        inputsDigest: expectedTipDigest
      })
    );
  });

  it('reports no-ready-task without side effects when none qualify', async () => {
    const state = baseState();
    const digest = implementationDigest(makeSpec().tasks[0], 'base-sha');
    state.taskResults['T-01'] = {
      taskId: 'T-01',
      status: 'failed',
      inputsDigest: digest,
      recordedAt: 'x'
    };
    stateMock.load.mockReturnValue(state);

    const pool = await executor.executeReady(INPUT);

    // T-01 already attempted (failed), T-02's dependency is unmerged.
    expect(pool.kind).toBe('no-ready-task');
    expect(stateMock.save).not.toHaveBeenCalled();
    expect(stateMock.recordTaskResult).not.toHaveBeenCalled();
    expect(agentRun).not.toHaveBeenCalled();
    expect(gitMock.addWorktree).not.toHaveBeenCalled();
  });

  it('runs the agent in a worktree on a deterministic branch', async () => {
    await executor.executeReady(INPUT);

    const expectedBranch = taskBranch('run-1', 'T-01');
    expect(expectedBranch).toBe('sdlc/run-1/T-01');
    const expectedWorktree = path.join('/runs', 'run-1', 'worktrees', 'T-01');
    expect(gitMock.fetch).toHaveBeenCalledWith('/repo');
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

  it('fetches origin before creating worktrees so post-merge tip SHAs resolve', async () => {
    await executor.executeReady(INPUT);

    expect(gitMock.fetch).toHaveBeenCalledWith('/repo');
    expect(gitMock.fetch.mock.invocationCallOrder[0]).toBeLessThan(
      gitMock.addWorktree.mock.invocationCallOrder[0]
    );
  });

  it('records a failure result instead of throwing when the agent fails', async () => {
    agentRun.mockResolvedValue({ ok: false, output: 'agent exploded' });

    const pool = await executor.executeReady(INPUT);

    expect(pool.outcomes[0].kind).toBe('failed');
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

    const pool = await executor.executeReady(INPUT);

    expect(pool.outcomes[0].kind).toBe('failed');
    expect(pool.outcomes[0].detail).toBe('spawn refused');
  });

  it('engine-commits a dirty worktree when the agent exits without committing (#41)', async () => {
    // Tip unchanged but dirty: husky typically blocked `sdlc/*` commits.
    let committed = false;
    gitMock.headSha.mockImplementation((repoPath: string) => {
      if (!repoPath.includes('worktrees')) return 'base-sha';
      return committed ? 'engine-sha' : 'base-sha';
    });
    gitMock.commit.mockImplementation(() => {
      committed = true;
    });
    gitMock.status.mockReturnValue(' M docs/live-validation.md\n');

    const pool = await executor.executeReady(INPUT);

    expect(pool.outcomes[0].kind).toBe('completed');
    expect(pool.outcomes[0].detail).toContain(
      'engine committed dirty worktree'
    );
    expect(gitMock.stageAll).toHaveBeenCalled();
    expect(gitMock.commit).toHaveBeenCalledWith(
      expect.stringContaining('worktrees/T-01'),
      expect.stringMatching(/^feat\(T-01\):/),
      { noVerify: true, signOff: true }
    );
    expect(stateMock.recordTaskResult).toHaveBeenCalledWith(
      '/runs',
      expect.anything(),
      expect.objectContaining({ taskId: 'T-01', status: 'completed' })
    );
  });

  it('records a failure when the agent exits with a clean tip and no commit', async () => {
    gitMock.headSha.mockReturnValue('base-sha');
    gitMock.status.mockReturnValue('');

    const pool = await executor.executeReady(INPUT);

    expect(pool.outcomes[0].kind).toBe('failed');
    expect(pool.outcomes[0].detail).toContain('produced no commit');
    expect(gitMock.commit).not.toHaveBeenCalled();
    expect(stateMock.recordStep).not.toHaveBeenCalled();
  });

  it('records a failure when engine salvage-commit throws (#41)', async () => {
    gitMock.headSha.mockReturnValue('base-sha');
    gitMock.status.mockReturnValue(' M src/a.ts\n');
    gitMock.commit.mockImplementation(() => {
      throw new Error('commit refused');
    });

    const pool = await executor.executeReady(INPUT);

    expect(pool.outcomes[0].kind).toBe('failed');
    expect(pool.outcomes[0].detail).toContain('engine commit failed');
    expect(pool.outcomes[0].detail).toContain('src/a.ts');
  });

  it('salvages a dirty tip after a non-ok agent exit (#41)', async () => {
    agentRun.mockResolvedValue({ ok: false, output: 'hook rejected commit' });
    let committed = false;
    gitMock.headSha.mockImplementation((repoPath: string) => {
      if (!repoPath.includes('worktrees')) return 'base-sha';
      return committed ? 'engine-sha' : 'base-sha';
    });
    gitMock.commit.mockImplementation(() => {
      committed = true;
    });
    gitMock.status.mockReturnValue('A  src/new.ts\n');

    const pool = await executor.executeReady(INPUT);

    expect(pool.outcomes[0].kind).toBe('completed');
    expect(pool.outcomes[0].detail).toContain('hook rejected commit');
    expect(pool.outcomes[0].detail).toContain(
      'engine committed dirty worktree'
    );
  });

  describe('P3 T-01 parallel pool', () => {
    const independentSpec = (): SpecDocument =>
      makeSpec({
        tasks: [makeTask(), makeTask({ id: 'T-02' }), makeTask({ id: 'T-03' })]
      });

    it('executes independent ready tasks concurrently in separate worktrees', async () => {
      specRead.mockReturnValue(independentSpec());
      // Neither agent resolves until both have been started — proof the
      // fan-out is concurrent, not sequential.
      const resolvers: ((v: { ok: boolean; output: string }) => void)[] = [];
      agentRun.mockImplementation(
        () =>
          new Promise(resolve => {
            resolvers.push(resolve);
          })
      );

      const poolPromise = executor.executeReady({ ...INPUT, maxParallel: 2 });
      await new Promise(resolve => setImmediate(resolve));
      expect(agentRun).toHaveBeenCalledTimes(2);
      // Completion order is reversed: results must still be recorded per
      // task, serialized on the shared state, none lost.
      resolvers[1]({ ok: true, output: 'done' });
      resolvers[0]({ ok: true, output: 'done' });
      const pool = await poolPromise;

      expect(pool.outcomes.map(o => o.task.id).sort()).toEqual([
        'T-01',
        'T-02'
      ]);
      const worktrees = agentRun.mock.calls.map(call => call[0]);
      expect(new Set(worktrees).size).toBe(2);
      const recorded = stateMock.recordTaskResult.mock.calls.map(
        call => call[2].taskId
      );
      expect(recorded.sort()).toEqual(['T-01', 'T-02']);
      const state = pool.state as RunState;
      expect(state.taskResults['T-01']).toBeDefined();
      expect(state.taskResults['T-02']).toBeDefined();
    });

    it('bounds the wave at maxParallel', async () => {
      specRead.mockReturnValue(independentSpec());

      const pool = await executor.executeReady({ ...INPUT, maxParallel: 2 });

      expect(pool.outcomes).toHaveLength(2);
      expect(agentRun).toHaveBeenCalledTimes(2);
    });

    it('a failed task blocks its dependents while unrelated tasks proceed', async () => {
      specRead.mockReturnValue(
        makeSpec({
          tasks: [
            makeTask(),
            makeTask({ id: 'T-02', dependsOn: ['T-01'] }),
            makeTask({ id: 'T-03' })
          ]
        })
      );
      const state = baseState();
      state.taskResults['T-01'] = {
        taskId: 'T-01',
        status: 'failed',
        inputsDigest: implementationDigest(makeTask(), 'base-sha'),
        recordedAt: 'x'
      };
      stateMock.load.mockReturnValue(state);

      const pool = await executor.executeReady(INPUT);

      // T-01 failed (not retried at unchanged content), T-02 blocked on it,
      // T-03 is unrelated and completes.
      expect(pool.outcomes.map(o => o.task.id)).toEqual(['T-03']);
      expect(pool.outcomes[0].kind).toBe('completed');
    });
  });

  describe('T-09 step cache', () => {
    it('records the implementation step on success', async () => {
      await executor.executeReady(INPUT);

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

      await executor.executeReady(INPUT);

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

      const pool = await executor.executeReady(INPUT);

      expect(pool.outcomes[0].kind).toBe('completed');
      expect(pool.outcomes[0].cached).toBe(true);
      expect(pool.outcomes[0].task.id).toBe('T-01');
      expect(pool.outcomes[0].branch).toBe('sdlc/run-1/T-01');
      expect(agentRun).not.toHaveBeenCalled();
      expect(gitMock.addWorktree).not.toHaveBeenCalled();
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

      const pool = await executor.executeReady(INPUT);

      // The edited task is re-selected and the agent re-invoked.
      expect(pool.outcomes[0].task.id).toBe('T-01');
      expect(pool.outcomes[0].cached).toBe(false);
      expect(agentRun).toHaveBeenCalledTimes(1);
      // Only T-01's chain is invalidated: T-02's cached step is untouched.
      expect((pool.state as RunState).steps[otherKey]).toBeDefined();
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

      const pool = await executor.executeReady(INPUT);

      expect(pool.kind).toBe('no-ready-task');
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

      const pool = await executor.executeReady(INPUT);

      expect(pool.outcomes[0].task.id).toBe('T-01');
      expect(agentRun).toHaveBeenCalledTimes(1);
    });

    it('does not reopen a merged task when the integration tip advances (#44 tip digest)', async () => {
      // Live-val shadow-2: after record-merge of T-02, state.mergedSha moves
      // to the merge tip → implementationDigest(T-02, tip) changes → without
      // an isMerged guard T-02 was re-selected, produced an empty diff, and
      // blocked T-03.
      const t01 = makeTask();
      const t02 = makeTask({ id: 'T-02', dependsOn: ['T-01'] });
      const t03 = makeTask({ id: 'T-03', dependsOn: ['T-02'] });
      specRead.mockReturnValue(makeSpec({ tasks: [t01, t02, t03] }));

      const oldTip = 'merge-t01';
      const newTip = 'merge-t02';
      const state = baseState();
      state.mergedSha = newTip;
      state.taskResults['T-01'] = {
        taskId: 'T-01',
        status: 'completed',
        mergedSha: oldTip,
        inputsDigest: implementationDigest(t01, 'base-sha'),
        recordedAt: 'x'
      };
      state.taskResults['T-02'] = {
        taskId: 'T-02',
        status: 'completed',
        mergedSha: newTip,
        // Digest rooted at the tip used when T-02 originally ran.
        inputsDigest: implementationDigest(t02, oldTip),
        recordedAt: 'x'
      };
      state.steps[stepKey('phase', 'T-02', 'old-phase')] = {
        name: 'phase',
        taskId: 'T-02',
        inputsDigest: 'old-phase',
        completedAt: 'x'
      };
      stateMock.load.mockReturnValue(state);

      const pool = await executor.executeReady(INPUT);

      expect(pool.outcomes.map(o => o.task.id)).toEqual(['T-03']);
      expect(agentRun).toHaveBeenCalledTimes(1);
    });
  });

  describe('P3 T-06 budget enforcement', () => {
    it('halts new agent dispatches when spend exceeds budgetK and records the escalation', async () => {
      const state = baseState();
      state.tokenSpendK = 250; // envelope default budgetK is 200
      stateMock.load.mockReturnValue(state);

      const pool = await executor.executeReady(INPUT);

      expect(agentRun).not.toHaveBeenCalled();
      expect(pool.outcomes[0]).toEqual(
        expect.objectContaining({
          kind: 'failed',
          detail: expect.stringContaining('budget exhausted')
        })
      );
      expect(state.exceptions).toContainEqual(
        expect.objectContaining({
          trigger: 'budget-exhaustion',
          taskId: 'T-01'
        })
      );
      // Worktree creation (non-agent) still happened before the dispatch check.
      expect(gitMock.addWorktree).toHaveBeenCalled();
    });

    it('meters token spend after each agent dispatch', async () => {
      await executor.executeReady(INPUT);

      expect(stateMock.recordTokenSpend).toHaveBeenCalledWith(
        '/runs',
        expect.anything(),
        5
      );
    });
  });
});
