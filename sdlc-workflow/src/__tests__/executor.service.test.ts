import 'reflect-metadata';
import { Container } from 'inversify';
import { existsSync, mkdtempSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import type { IAgentRunnerRepository } from '../repositories/agent-runner.repository';
import type { IGitRepository } from '../repositories/git.repository';
import type { IRunStateRepository } from '../repositories/run-state.repository';
import { RunStateRepository } from '../repositories/run-state.repository';
import { RunLockRepository } from '../repositories/run-lock.repository';
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
  // In-repo: an enforcing run refuses a spec it cannot compare against the
  // default branch, and a spec outside the repo has nothing to compare to.
  specPath: '/repo/specs/spec.md',
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
  gateFixAttempts: {},
  remediations: {},
  mergeBlockedRetries: 0,
  updatedAt: 'x'
});

describe('ExecutorService (P2 T-01 + P3 T-01 pool)', () => {
  let executor: IExecutorService;
  let specRead: jest.Mock;
  let specReadAtRef: jest.Mock;
  let gitMock: jest.Mocked<IGitRepository>;
  let agentRun: jest.Mock;
  let stateMock: jest.Mocked<IRunStateRepository>;

  beforeEach(() => {
    specRead = jest.fn().mockReturnValue(makeSpec());
    specReadAtRef = jest.fn().mockReturnValue(makeSpec());
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
      treeSha: jest.fn(),
      worktreeForBranch: jest.fn(),
      refExists: jest.fn().mockReturnValue(false),
      defaultBranch: jest.fn().mockReturnValue('build-env/dev'),
      fileAtRef: jest.fn(),
      pathDiffersFromRef: jest.fn().mockReturnValue(false),
      revertMerge: jest.fn(),
      stageAll: jest.fn(),
      commit: jest.fn(),
      listFiles: jest.fn().mockReturnValue([]),
      removeWorktreeAsync: jest.fn()
    };
    agentRun = jest.fn().mockResolvedValue({ ok: true, output: 'done' });
    stateMock = {
      load: jest.fn().mockReturnValue(null),
      idleSeconds: jest.fn().mockReturnValue(null),
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
        }),
      recordGateFixAttempt: jest.fn(),
      recordRemediation: jest.fn(),
      recordMergeBlockedRetry: jest.fn(),
      invalidateSteps: jest.fn().mockReturnValue([])
    };

    const container = new Container();
    container
      .bind<ISpecDocRepository>(WORKFLOW_TOKENS.SpecDocRepository)
      .toConstantValue({ read: specRead, readAtRef: specReadAtRef });
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
    specReadAtRef.mockReturnValue(makeSpec({ status: 'Draft' }));

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

  describe('spec provenance', () => {
    it('blocks when the spec has not landed on the default branch', async () => {
      specReadAtRef.mockReturnValue(null);

      const pool = await executor.executeReady(INPUT);

      expect(pool.kind).toBe('blocked');
      expect(pool.detail).toBe('spec-not-merged');
      expect(specReadAtRef).toHaveBeenCalledWith(
        '/repo',
        'origin/build-env/dev',
        'specs/spec.md'
      );
      expect(agentRun).not.toHaveBeenCalled();
      expect(gitMock.addWorktree).not.toHaveBeenCalled();
    });

    it('does not block when the local working tree differs from origin', async () => {
      // Stale operator checkout used to fail intake; enforce now trusts origin.
      gitMock.pathDiffersFromRef.mockReturnValue(true);
      specReadAtRef.mockReturnValue(makeSpec());

      const pool = await executor.executeReady(INPUT);

      expect(pool.kind).not.toBe('blocked');
      expect(specReadAtRef).toHaveBeenCalled();
      expect(gitMock.pathDiffersFromRef).not.toHaveBeenCalled();
    });

    it('refuses a spec outside the repo, which has nothing to compare to', async () => {
      const pool = await executor.executeReady({
        ...INPUT,
        specPath: '/outside/spec.md'
      });

      expect(pool.kind).toBe('blocked');
      expect(pool.detail).toBe('spec-not-merged');
      const verdict = stateMock.appendVerdict.mock.calls[0][2];
      expect(verdict.reasons.join(' ')).toContain('outside the repo');
    });

    it('fetches first so the origin blob is current', async () => {
      await executor.executeReady(INPUT);

      expect(gitMock.fetch).toHaveBeenCalledWith('/repo');
    });

    // Shadow runs never merge, so working from an unlanded spec is the point.
    it('skips origin load in shadow mode and uses the local file', async () => {
      specReadAtRef.mockReturnValue(null);

      const pool = await executor.executeReady({ ...INPUT, shadow: true });

      expect(pool.kind).not.toBe('blocked');
      expect(specRead).toHaveBeenCalled();
      expect(specReadAtRef).not.toHaveBeenCalled();
    });
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

  // Wave 0: breach-terminal-per-digest is right for identical content, but a
  // remediation round deliberately changes the task head — and the
  // implementation digest is rooted at {task content, integration tip},
  // neither of which moves when the agent commits a fix. Without this the fix
  // would sit on the branch forever, never judged.
  describe('remediated tasks reopen for a re-gate (Wave 0)', () => {
    const breachedState = (remediatedAt?: string) => {
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
        completedAt: '2026-08-05T10:00:00.000Z'
      };
      state.steps[stepKey('phase', 'T-01', 'p')] = {
        name: 'phase',
        taskId: 'T-01',
        inputsDigest: 'p',
        completedAt: '2026-08-05T10:00:00.000Z',
        verdict: {
          gate: 'phase',
          outcome: 'breach',
          wouldEscalate: true,
          reasons: ['failing gates: reviewer'],
          recordedAt: 'x'
        }
      };
      if (remediatedAt !== undefined) {
        state.remediations['T-01'] = {
          attempt: 1,
          sha: 'fix-sha',
          gates: ['reviewer'],
          recordedAt: remediatedAt
        };
      }
      return state;
    };

    it('re-selects a breached task whose remediation landed after the phase step', async () => {
      stateMock.load.mockReturnValue(breachedState('2026-08-05T10:05:00.000Z'));

      const pool = await executor.executeReady(INPUT);

      expect(pool.kind).toBe('executed');
      expect(pool.outcomes[0].task.id).toBe('T-01');
      // The implementation is cached — only the gates need to run again, so
      // the re-gate costs a reviewer round, not a fresh implementation.
      expect(pool.outcomes[0].cached).toBe(true);
      expect(agentRun).not.toHaveBeenCalled();
    });

    it('leaves a breached task terminal when the remediation predates the phase step', async () => {
      // The phase gate already judged this fix and still breached — reopening
      // would loop on content the gates have seen.
      stateMock.load.mockReturnValue(breachedState('2026-08-05T09:55:00.000Z'));

      const pool = await executor.executeReady(INPUT);

      expect(pool.kind).toBe('no-ready-task');
    });

    it('leaves a breached task with no remediation terminal', async () => {
      stateMock.load.mockReturnValue(breachedState());

      const pool = await executor.executeReady(INPUT);

      expect(pool.kind).toBe('no-ready-task');
    });

    it('does not reopen a remediated task that already merged', async () => {
      const state = breachedState('2026-08-05T10:05:00.000Z');
      state.taskResults['T-01'].mergedSha = 'merge-sha';
      state.steps[stepKey('merge', 'T-01', 'm')] = {
        name: 'merge',
        taskId: 'T-01',
        inputsDigest: 'm',
        completedAt: '2026-08-05T10:10:00.000Z'
      };
      stateMock.load.mockReturnValue(state);

      const pool = await executor.executeReady(INPUT);

      // T-02 becomes eligible instead; T-01 is terminal.
      expect(pool.outcomes.map(o => o.task.id)).toEqual(['T-02']);
    });
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
      specReadAtRef.mockReturnValue(independentSpec());
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
      specReadAtRef.mockReturnValue(independentSpec());

      const pool = await executor.executeReady({ ...INPUT, maxParallel: 2 });

      expect(pool.outcomes).toHaveLength(2);
      expect(agentRun).toHaveBeenCalledTimes(2);
    });

    it('a failed task blocks its dependents while unrelated tasks proceed', async () => {
      specReadAtRef.mockReturnValue(
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
      specReadAtRef.mockReturnValue(makeSpec({ tasks: [t01, t02, t03] }));

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

describe('fail-loud T-01 launch record (#37)', () => {
  let executor: IExecutorService;
  let specRead: jest.Mock;
  let specReadAtRef: jest.Mock;
  let gitMock: jest.Mocked<IGitRepository>;
  let agentRun: jest.Mock;
  let runsDir: string;
  let stateRepo: RunStateRepository;

  beforeEach(() => {
    runsDir = mkdtempSync(path.join(os.tmpdir(), 'sdlc-launch-'));
    stateRepo = new RunStateRepository(new RunLockRepository());
    specRead = jest.fn().mockReturnValue(makeSpec());
    specReadAtRef = jest.fn().mockReturnValue(makeSpec());
    gitMock = {
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
      treeSha: jest.fn(),
      worktreeForBranch: jest.fn(),
      refExists: jest.fn().mockReturnValue(false),
      defaultBranch: jest.fn().mockReturnValue('build-env/dev'),
      fileAtRef: jest.fn(),
      pathDiffersFromRef: jest.fn().mockReturnValue(false),
      revertMerge: jest.fn(),
      stageAll: jest.fn(),
      commit: jest.fn(),
      listFiles: jest.fn().mockReturnValue([]),
      removeWorktreeAsync: jest.fn()
    };
    agentRun = jest.fn().mockResolvedValue({ ok: true, output: 'done' });

    const container = new Container();
    container
      .bind<ISpecDocRepository>(WORKFLOW_TOKENS.SpecDocRepository)
      .toConstantValue({ read: specRead, readAtRef: specReadAtRef });
    container
      .bind<IGitRepository>(WORKFLOW_TOKENS.GitRepository)
      .toConstantValue(gitMock);
    container
      .bind<IAgentRunnerRepository>(WORKFLOW_TOKENS.AgentRunnerRepository)
      .toConstantValue({ run: agentRun });
    container
      .bind<IRunStateRepository>(WORKFLOW_TOKENS.RunStateRepository)
      .toConstantValue(stateRepo);
    container
      .bind<IExecutorService>(WORKFLOW_TOKENS.ExecutorService)
      .to(ExecutorService);
    executor = container.get<IExecutorService>(WORKFLOW_TOKENS.ExecutorService);
  });

  afterEach(() => rmSync(runsDir, { recursive: true, force: true }));

  const launchInput = () => ({
    ...INPUT,
    runsDir,
    launchArgv: ['node', 'sdlc-workflow', 'run', '--spec', INPUT.specPath]
  });

  it('leaves a readable launch state when killed between intake and the first recorded step', async () => {
    agentRun.mockImplementation(async () => {
      const mid = stateRepo.load(runsDir, 'run-1');
      expect(mid).not.toBeNull();
      expect(mid!.runId).toBe('run-1');
      expect(mid!.startedAt).toEqual(expect.any(String));
      expect(mid!.specDigest).toEqual(expect.any(String));
      expect(mid!.specDigest!.length).toBeGreaterThan(0);
      expect(mid!.baseSha).toBe('base-sha');
      expect(mid!.launchArgv).toEqual(launchInput().launchArgv);
      expect(mid!.steps).toEqual({});
      throw new Error('killed between intake and first step');
    });

    await executor.executeReady(launchInput());

    const state = stateRepo.load(runsDir, 'run-1');
    expect(state).not.toBeNull();
    expect(state!.startedAt).toEqual(expect.any(String));
    expect(state!.specDigest!.length).toBeGreaterThan(0);
    // status --run-id loads this same file — never RUN_NOT_FOUND.
    expect(stateRepo.load(runsDir, 'run-1')?.runId).toBe('run-1');
  });

  it('records a refused intake in run state without creating a daemon-relaunchable half-run', async () => {
    specReadAtRef.mockReturnValue(makeSpec({ status: 'Draft' }));

    const pool = await executor.executeReady(launchInput());

    expect(pool.kind).toBe('blocked');
    expect(pool.detail).toBe('unapproved-spec');

    const state = stateRepo.load(runsDir, 'run-1');
    expect(state).not.toBeNull();
    expect(state!.verdicts).toContainEqual(
      expect.objectContaining({
        gate: 'intake',
        outcome: 'blocked',
        reasons: expect.arrayContaining(['unapproved-spec'])
      })
    );
    // Empty task/step maps: continuity daemon's run_is_finished stays
    // false, but with no supervise.pid (executor never writes one) and a
    // recorded intake refusal it is not a half-run the daemon would resume.
    expect(state!.taskResults).toEqual({});
    expect(state!.steps).toEqual({});
    expect(existsSync(path.join(runsDir, 'run-1', 'supervise.pid'))).toBe(
      false
    );
  });

  it('preserves step-cache resume for a normally-progressing run', async () => {
    const first = await executor.executeReady(launchInput());
    expect(first.kind).toBe('executed');
    expect(first.outcomes[0].cached).toBe(false);

    const afterFirst = stateRepo.load(runsDir, 'run-1');
    expect(afterFirst).not.toBeNull();
    const implKey = Object.keys(afterFirst!.steps).find(k =>
      k.startsWith('implementation:T-01:')
    );
    expect(implKey).toBeDefined();

    agentRun.mockClear();
    gitMock.addWorktree.mockClear();

    const resumed = await executor.executeReady(launchInput());
    expect(resumed.kind).toBe('executed');
    expect(resumed.outcomes[0].cached).toBe(true);
    expect(agentRun).not.toHaveBeenCalled();
    expect(gitMock.addWorktree).not.toHaveBeenCalled();
    expect(stateRepo.load(runsDir, 'run-1')!.steps[implKey!]).toEqual(
      afterFirst!.steps[implKey!]
    );
  });
});
