import 'reflect-metadata';
import { Container } from 'inversify';
import type { IAgentRunnerRepository } from '../repositories/agent-runner.repository';
import type { ICiStatusRepository } from '../repositories/ci-status.repository';
import type { IGitRepository } from '../repositories/git.repository';
import type { IRunStateRepository } from '../repositories/run-state.repository';
import {
  CI_FIX_ATTEMPT_LIMIT,
  CiGateService,
  ICiGateService
} from '../services/ci-gate.service';
import { WORKFLOW_TOKENS } from '../tokens';
import { RunState } from '../types';
import { makeTask } from './fixtures';

const makeState = (): RunState => ({
  runId: 'run-1',
  specId: 'SPEC-PRD-0099-P3',
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

const green = { total: 2, failed: [], pending: [] };
const red = { total: 2, failed: ['ci'], pending: [] };

describe('CiGateService (P3 T-03 live monitor + bounded fix cycle)', () => {
  let gate: ICiGateService;
  let state: RunState;
  let checkRuns: jest.Mock;
  let failedLogs: jest.Mock;
  let agentRun: jest.Mock;
  let headSha: jest.Mock;
  let push: jest.Mock;
  let status: jest.Mock;
  let stageAll: jest.Mock;
  let commit: jest.Mock;
  let recordCiFixAttempt: jest.Mock;

  const input = () => ({
    repoPath: '/repo',
    worktreePath: '/runs/run-1/worktrees/T-01',
    branch: 'sdlc/run-1/T-01',
    sha: 'abc123',
    task: makeTask(),
    runsDir: '/runs',
    state,
    budgetK: 200,
    pollIntervalMs: 1,
    timeoutMs: 5_000
  });

  beforeEach(() => {
    state = makeState();
    checkRuns = jest.fn();
    failedLogs = jest.fn().mockReturnValue('TS2304: Cannot find name "foo"');
    agentRun = jest.fn().mockResolvedValue({ ok: true, output: 'fixed' });
    // Each fix commit produces a new head SHA.
    let fixCount = 0;
    headSha = jest.fn().mockImplementation(() => `fixed-sha-${++fixCount}`);
    push = jest.fn();
    status = jest.fn().mockReturnValue('');
    stageAll = jest.fn();
    commit = jest.fn();
    recordCiFixAttempt = jest
      .fn()
      .mockImplementation((_d, s: RunState, taskId: string) => {
        s.ciFixAttempts[taskId] = (s.ciFixAttempts[taskId] ?? 0) + 1;
        return s.ciFixAttempts[taskId];
      });

    const container = new Container();
    container
      .bind<ICiStatusRepository>(WORKFLOW_TOKENS.CiStatusRepository)
      .toConstantValue({
        checkRuns,
        failedLogs,
        createStatus: jest.fn()
      });
    container
      .bind<IAgentRunnerRepository>(WORKFLOW_TOKENS.AgentRunnerRepository)
      .toConstantValue({ run: agentRun });
    container
      .bind<IGitRepository>(WORKFLOW_TOKENS.GitRepository)
      .toConstantValue({
        headSha,
        push,
        status,
        addWorktree: jest.fn(),
        diffStat: jest.fn(),
        diffText: jest.fn(),
        fetch: jest.fn(),
        resolveSha: jest.fn(),
        defaultBranch: jest.fn(),
        fileAtRef: jest.fn().mockReturnValue(null),
        pathDiffersFromRef: jest.fn().mockReturnValue(false),
        revertMerge: jest.fn(),
        stageAll,
        commit,
        removeWorktreeAsync: jest.fn()
      });
    container
      .bind<IRunStateRepository>(WORKFLOW_TOKENS.RunStateRepository)
      .toConstantValue({
        recordCiFixAttempt,
        load: jest.fn(),
        save: jest.fn(),
        appendVerdict: jest.fn(),
        recordTaskResult: jest.fn(),
        recordExceptions: jest.fn(),
        recordSandbox: jest.fn(),
        recordCriteria: jest.fn(),
        recordStep: jest.fn(),
        recordMergedSha: jest.fn(),
        recordTaskMerged: jest.fn(),
        recordTaskPrUrl: jest.fn(),
        recordTokenSpend: jest
          .fn()
          .mockImplementation((_d, s: RunState, delta: number) => {
            s.tokenSpendK = (s.tokenSpendK ?? 0) + delta;
            return s.tokenSpendK;
          })
      });
    container
      .bind<ICiGateService>(WORKFLOW_TOKENS.CiGateService)
      .to(CiGateService);
    gate = container.get<ICiGateService>(WORKFLOW_TOKENS.CiGateService);
  });

  it('blocks honestly when the commit has no CI results (not pushed)', async () => {
    checkRuns.mockReturnValue(null);

    const verdict = await gate.monitor(input());

    expect(verdict.gate).toBe('ci');
    expect(verdict.outcome).toBe('blocked');
    expect(verdict.wouldEscalate).toBe(false);
    expect(verdict.reasons[0]).toContain('no CI results for abc123');
    expect(verdict.taskId).toBe('T-01');
    expect(agentRun).not.toHaveBeenCalled();
  });

  it('waits for check runs to register before treating zero as terminal', async () => {
    checkRuns
      .mockReturnValueOnce({ total: 0, failed: [], pending: [] })
      .mockReturnValueOnce({ total: 0, failed: [], pending: [] })
      .mockReturnValue(green);

    const verdict = await gate.monitor({
      ...input(),
      pollIntervalMs: 1,
      timeoutMs: 5_000
    });

    expect(verdict.outcome).toBe('pass');
    expect(verdict.transcript).toContain(
      'waiting for check runs to register for abc123'
    );
    expect(checkRuns).toHaveBeenCalledTimes(3);
  });

  it('blocks when zero check runs persist through the deadline', async () => {
    checkRuns.mockReturnValue({ total: 0, failed: [], pending: [] });

    const verdict = await gate.monitor({
      ...input(),
      pollIntervalMs: 1,
      timeoutMs: 5
    });

    expect(verdict.outcome).toBe('blocked');
    expect(verdict.reasons[0]).toContain('no check runs');
  });

  it('polls pending checks to terminal and passes on green with evidence', async () => {
    checkRuns
      .mockReturnValueOnce({ total: 2, failed: [], pending: ['ci'] })
      .mockReturnValueOnce({ total: 2, failed: [], pending: ['ci'] })
      .mockReturnValue(green);

    const verdict = await gate.monitor(input());

    expect(verdict.outcome).toBe('pass');
    expect(verdict.reasons).toEqual(['2 check runs green for abc123']);
    // Evidence: the cycle transcript records what was observed.
    expect(verdict.transcript).toContain('waiting on 1 pending check(s)');
    expect(verdict.transcript).toContain('2 check runs green for abc123');
    expect(checkRuns).toHaveBeenCalledTimes(3);
    expect(agentRun).not.toHaveBeenCalled();
    expect(state.ciFixAttempts['T-01']).toBeUndefined();
  });

  it('blocks (would escalate) when checks are still pending at the deadline', async () => {
    checkRuns.mockReturnValue({ total: 2, failed: [], pending: ['e2e'] });

    const verdict = await gate.monitor({ ...input(), timeoutMs: 5 });

    expect(verdict.outcome).toBe('blocked');
    expect(verdict.wouldEscalate).toBe(true);
    expect(verdict.reasons[0]).toContain('still pending at timeout: e2e');
  });

  it('dispatches the fix agent with the failing output, increments attempts, and re-evaluates (green after fix)', async () => {
    checkRuns
      .mockReturnValueOnce(red) // abc123 fails
      .mockReturnValue(green); // fixed sha is green

    const verdict = await gate.monitor(input());

    expect(recordCiFixAttempt).toHaveBeenCalledTimes(1);
    expect(state.ciFixAttempts['T-01']).toBe(1);
    // The failing check output is in the fix agent's prompt.
    expect(agentRun).toHaveBeenCalledTimes(1);
    const [cwd, prompt] = agentRun.mock.calls[0];
    expect(cwd).toBe('/runs/run-1/worktrees/T-01');
    expect(prompt).toContain('check');
    expect(prompt).toContain('ci');
    expect(prompt).toContain('TS2304: Cannot find name "foo"');
    expect(prompt).toContain('attempt 1 of 3');
    // The fix commit was pushed and the new sha re-evaluated to green.
    expect(push).toHaveBeenCalledWith(
      '/runs/run-1/worktrees/T-01',
      'sdlc/run-1/T-01'
    );
    expect(verdict.outcome).toBe('pass');
    expect(verdict.reasons[0]).toContain('fixed-sha-1');
  });

  it('stops after the third failing attempt: escalating breach, no fourth dispatch', async () => {
    checkRuns.mockReturnValue(red); // every sha keeps failing

    const verdict = await gate.monitor(input());

    expect(agentRun).toHaveBeenCalledTimes(CI_FIX_ATTEMPT_LIMIT);
    expect(state.ciFixAttempts['T-01']).toBe(CI_FIX_ATTEMPT_LIMIT);
    expect(verdict.outcome).toBe('breach');
    expect(verdict.wouldEscalate).toBe(true);
    expect(verdict.reasons).toContainEqual(
      expect.stringContaining('check failed: ci')
    );
    expect(verdict.reasons).toContainEqual(
      expect.stringContaining('ci-fix attempts exhausted (3/3)')
    );
  });

  it('skips the fix agent when the token budget is exhausted (P3 T-06)', async () => {
    state.tokenSpendK = 250;
    checkRuns.mockReturnValue(red);

    const verdict = await gate.monitor(input());

    expect(verdict.outcome).toBe('breach');
    expect(verdict.reasons.join(' ')).toContain('budget exhausted');
    expect(agentRun).not.toHaveBeenCalled();
    expect(recordCiFixAttempt).not.toHaveBeenCalled();
  });

  it('resume honours previously spent attempts (persisted budget)', async () => {
    state.ciFixAttempts['T-01'] = CI_FIX_ATTEMPT_LIMIT;
    checkRuns.mockReturnValue(red);

    const verdict = await gate.monitor(input());

    expect(agentRun).not.toHaveBeenCalled();
    expect(verdict.outcome).toBe('breach');
    expect(verdict.reasons).toContainEqual(
      expect.stringContaining('exhausted')
    );
  });

  it('a fix agent that produces no commit consumes the attempt without a push', async () => {
    checkRuns.mockReturnValue(red);
    headSha.mockReturnValue('abc123'); // no new commit, ever

    const verdict = await gate.monitor(input());

    expect(agentRun).toHaveBeenCalledTimes(CI_FIX_ATTEMPT_LIMIT);
    expect(push).not.toHaveBeenCalled();
    expect(verdict.outcome).toBe('breach');
    expect(verdict.transcript).toContain('produced no commit');
  });

  it('engine-commits a dirty CI fix worktree when the agent left no tip advance (#41)', async () => {
    // First poll red at abc123; after salvage commit, new sha goes green.
    checkRuns.mockReturnValueOnce(red).mockReturnValueOnce(green);
    let committed = false;
    headSha.mockImplementation(() =>
      committed ? 'fixed-by-engine' : 'abc123'
    );
    status.mockReturnValue(' M src/a.ts\n');
    commit.mockImplementation(() => {
      committed = true;
    });

    const verdict = await gate.monitor(input());

    expect(stageAll).toHaveBeenCalledWith('/runs/run-1/worktrees/T-01');
    expect(commit).toHaveBeenCalledWith(
      '/runs/run-1/worktrees/T-01',
      expect.stringMatching(/^fix\(T-01\):/),
      { noVerify: true, signOff: true }
    );
    expect(push).toHaveBeenCalled();
    expect(verdict.outcome).toBe('pass');
    expect(verdict.transcript).toContain('engine committed dirty CI fix');
  });

  it('records engine commit failure for a dirty CI fix without advancing (#41)', async () => {
    checkRuns.mockReturnValue(red);
    headSha.mockReturnValue('abc123');
    status.mockReturnValue(' M src/a.ts\n');
    commit.mockImplementation(() => {
      throw new Error('hook exploded');
    });

    const verdict = await gate.monitor(input());

    expect(verdict.outcome).toBe('breach');
    expect(verdict.transcript).toContain('engine commit failed');
    expect(push).not.toHaveBeenCalled();
  });
});
