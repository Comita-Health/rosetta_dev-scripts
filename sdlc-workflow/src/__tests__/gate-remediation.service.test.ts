import 'reflect-metadata';
import { Container } from 'inversify';
import type { IAgentRunnerRepository } from '../repositories/agent-runner.repository';
import type { IGitRepository } from '../repositories/git.repository';
import type { IRunStateRepository } from '../repositories/run-state.repository';
import {
  GATE_FIX_ATTEMPT_LIMIT,
  GateRemediationService,
  IGateRemediationService,
  remediableVerdicts
} from '../services/gate-remediation.service';
import { WORKFLOW_TOKENS } from '../tokens';
import { GateVerdict, RunState } from '../types';
import { makeEnvelope, makeTask } from './fixtures';

const verdict = (
  gate: string,
  outcome: GateVerdict['outcome'],
  reasons: string[] = ['why']
): GateVerdict => ({
  gate,
  outcome,
  wouldEscalate: outcome !== 'pass',
  reasons,
  recordedAt: 'x'
});

const makeState = (overrides: Partial<RunState> = {}): RunState => ({
  runId: 'run-1',
  specId: 'SPEC-PRD-0099-P1',
  specPath: '/specs/spec.md',
  baseSha: 'base',
  taskResults: {},
  verdicts: [],
  exceptions: [],
  criterionVerdicts: [],
  steps: {},
  tokenSpendK: 0,
  ciFixAttempts: {},
  gateFixAttempts: {},
  operatorUnstickAttempts: {},
  operatorUnstickOutcomes: {},
  escalateTiers: {},
  remediations: {},
  mergeBlockedRetries: 0,
  updatedAt: 'x',
  ...overrides
});

describe('GateRemediationService (Wave 0 bounded gate re-dispatch)', () => {
  let service: IGateRemediationService;
  let state: RunState;
  let agentRun: jest.Mock;
  let headSha: jest.Mock;
  let push: jest.Mock;
  let status: jest.Mock;
  let stageAll: jest.Mock;
  let commit: jest.Mock;
  let recordGateFixAttempt: jest.Mock;
  let recordRemediation: jest.Mock;
  let recordTokenSpend: jest.Mock;

  const input = (over: Record<string, unknown> = {}) => ({
    worktreePath: '/runs/run-1/worktrees/T-01',
    branch: 'sdlc/run-1/T-01',
    task: makeTask(),
    envelope: makeEnvelope(),
    runsDir: '/runs',
    state,
    verdicts: [verdict('reviewer', 'breach', ['unsafe migration'])],
    budgetK: 200,
    ...over
  });

  beforeEach(() => {
    state = makeState();
    agentRun = jest.fn().mockResolvedValue({ ok: true, output: '' });
    // The agent commits, so head moves.
    headSha = jest
      .fn()
      .mockReturnValueOnce('before-sha')
      .mockReturnValue('after-sha');
    push = jest.fn();
    status = jest.fn().mockReturnValue('');
    stageAll = jest.fn();
    commit = jest.fn();
    recordGateFixAttempt = jest
      .fn()
      .mockImplementation((_d, s: RunState, taskId: string) => {
        s.gateFixAttempts[taskId] = (s.gateFixAttempts[taskId] ?? 0) + 1;
        return s.gateFixAttempts[taskId];
      });
    recordRemediation = jest.fn();
    recordTokenSpend = jest
      .fn()
      .mockImplementation((_d, s: RunState, delta: number) => {
        s.tokenSpendK = (s.tokenSpendK ?? 0) + delta;
        return s.tokenSpendK;
      });

    const container = new Container();
    container
      .bind<IAgentRunnerRepository>(WORKFLOW_TOKENS.AgentRunnerRepository)
      .toConstantValue({ run: agentRun });
    container
      .bind<IGitRepository>(WORKFLOW_TOKENS.GitRepository)
      .toConstantValue({
        headSha,
        push,
        status,
        stageAll,
        commit,
        addWorktree: jest.fn(),
        diffStat: jest.fn(),
        diffText: jest.fn(),
        fetch: jest.fn(),
        defaultBranch: jest.fn(),
        readAtRef: jest.fn(),
        removeWorktree: jest.fn(),
        removeWorktreeAsync: jest.fn(),
        revParse: jest.fn()
      } as unknown as IGitRepository);
    container
      .bind<IRunStateRepository>(WORKFLOW_TOKENS.RunStateRepository)
      .toConstantValue({
        recordGateFixAttempt,
        recordRemediation,
        recordTokenSpend
      } as unknown as IRunStateRepository);
    container
      .bind<IGateRemediationService>(WORKFLOW_TOKENS.GateRemediationService)
      .to(GateRemediationService);
    service = container.get(WORKFLOW_TOKENS.GateRemediationService);
  });

  it('dispatches a fix agent for a reviewer breach, pushes it, and records the remediation', async () => {
    const outcome = await service.remediate(input());

    expect(outcome).toMatchObject({
      kind: 'remediated',
      attempt: 1,
      sha: 'after-sha'
    });
    expect(agentRun).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledWith(
      '/runs/run-1/worktrees/T-01',
      'sdlc/run-1/T-01'
    );
    expect(recordRemediation).toHaveBeenCalledWith(
      '/runs',
      state,
      'T-01',
      'after-sha',
      ['reviewer']
    );
  });

  it('gives the agent the failing reasons and the fixed envelope', async () => {
    await service.remediate(
      input({
        verdicts: [
          verdict('envelope', 'breach', ['diff is 900 non-test lines'])
        ]
      })
    );

    const prompt = agentRun.mock.calls[0][1] as string;
    expect(prompt).toContain('diff is 900 non-test lines');
    expect(prompt).toContain('TRIMMING the change');
    // The one thing the agent must never do to clear an envelope breach.
    expect(prompt).toContain('Never edit the spec to raise a limit');
  });

  it('carries prior findings forward so a second round sees what the first was told', async () => {
    state.verdicts = [
      { ...verdict('reviewer', 'breach', ['stale mock']), taskId: 'T-01' },
      // Another task's finding must not leak into this task's prompt.
      { ...verdict('reviewer', 'breach', ['other task']), taskId: 'T-02' },
      // A passing verdict is not a finding.
      { ...verdict('reviewer', 'pass', ['fine']), taskId: 'T-01' }
    ];

    await service.remediate(input());

    const prompt = agentRun.mock.calls[0][1] as string;
    expect(prompt).toContain('Already raised on earlier attempts');
    expect(prompt).toContain('stale mock');
    expect(prompt).not.toContain('other task');
    expect(prompt).not.toContain('fine');
  });

  it('skips when no gate finding is remediable', async () => {
    const outcome = await service.remediate(
      input({
        // A manual-tier verification failure needs a human, not another
        // agent round.
        verdicts: [verdict('verification', 'breach', ['manual: sign off'])]
      })
    );

    expect(outcome).toMatchObject({ kind: 'skipped' });
    expect(outcome.detail).toContain('no remediable gate');
    expect(agentRun).not.toHaveBeenCalled();
  });

  it('skips a gate that passed even when it is remediable in principle', async () => {
    const outcome = await service.remediate(
      input({ verdicts: [verdict('reviewer', 'pass', [])] })
    );

    expect(outcome.kind).toBe('skipped');
    expect(agentRun).not.toHaveBeenCalled();
  });

  it('stops at the attempt limit so reviewer ping-pong cannot spin', async () => {
    state.gateFixAttempts = { 'T-01': GATE_FIX_ATTEMPT_LIMIT };

    const outcome = await service.remediate(input());

    expect(outcome).toMatchObject({ kind: 'skipped' });
    expect(outcome.detail).toContain('attempts exhausted');
    expect(agentRun).not.toHaveBeenCalled();
  });

  it('skips once the envelope token budget is spent', async () => {
    state.tokenSpendK = 600;

    const outcome = await service.remediate(input({ budgetK: 200 }));

    expect(outcome).toMatchObject({ kind: 'skipped' });
    expect(outcome.detail).toContain('budget exhausted');
    expect(agentRun).not.toHaveBeenCalled();
  });

  it('salvages a dirty worktree the agent could not commit (husky on sdlc/*)', async () => {
    headSha
      .mockReset()
      .mockReturnValueOnce('before-sha') // before dispatch
      .mockReturnValueOnce('before-sha') // agent left head unchanged
      .mockReturnValue('salvaged-sha'); // after the engine commit
    status.mockReturnValue(' M src/a.ts\n');

    const outcome = await service.remediate(input());

    expect(stageAll).toHaveBeenCalled();
    expect(commit).toHaveBeenCalledWith(
      '/runs/run-1/worktrees/T-01',
      expect.stringContaining('fix(T-01)'),
      { noVerify: true, signOff: true }
    );
    expect(outcome).toMatchObject({ kind: 'remediated', sha: 'salvaged-sha' });
  });

  it('reports failure when even the salvage commit is rejected', async () => {
    headSha.mockReset().mockReturnValue('before-sha');
    status.mockReturnValue(' M src/a.ts\n');
    commit.mockImplementation(() => {
      throw new Error('pre-commit hook failed');
    });

    const outcome = await service.remediate(input());

    // A worktree the engine cannot commit produces no new ref for the gates
    // to judge, so it is a spent attempt — not a remediation.
    expect(outcome).toMatchObject({ kind: 'failed', attempt: 1 });
    expect(push).not.toHaveBeenCalled();
    expect(recordRemediation).not.toHaveBeenCalled();
  });

  it('reports failure when the agent leaves nothing to commit', async () => {
    headSha.mockReset().mockReturnValue('before-sha');
    status.mockReturnValue('');

    const outcome = await service.remediate(input());

    expect(outcome).toMatchObject({ kind: 'failed', attempt: 1 });
    expect(outcome.detail).toContain('no commit');
    expect(push).not.toHaveBeenCalled();
    expect(recordRemediation).not.toHaveBeenCalled();
  });

  // The gates judge the pushed ref, so an unpushed fix is not a remediation
  // — reporting it as one would strand the task waiting on a re-gate that
  // has nothing new to look at.
  it('does not report remediated when the push fails', async () => {
    push.mockImplementation(() => {
      throw new Error('non-fast-forward');
    });

    const outcome = await service.remediate(input());

    expect(outcome.kind).toBe('failed');
    expect(outcome.detail).toContain('push failed');
    expect(recordRemediation).not.toHaveBeenCalled();
  });

  it('meters token spend even when the agent dispatch throws', async () => {
    agentRun.mockRejectedValue(new Error('transport died'));
    headSha.mockReset().mockReturnValue('before-sha');
    status.mockReturnValue('');

    const outcome = await service.remediate(input());

    expect(recordTokenSpend).toHaveBeenCalled();
    expect(outcome.kind).toBe('failed');
    expect(outcome.detail).toContain('transport died');
  });

  it('spends an attempt for a failed round, so failures cannot loop for free', async () => {
    headSha.mockReset().mockReturnValue('before-sha');
    status.mockReturnValue('');

    await service.remediate(input());

    expect(state.gateFixAttempts['T-01']).toBe(1);
  });

  describe('remediableVerdicts', () => {
    it('selects only failing reviewer and envelope verdicts', () => {
      const selected = remediableVerdicts([
        verdict('reviewer', 'breach'),
        verdict('envelope', 'breach'),
        verdict('reviewer', 'pass'),
        verdict('ci', 'blocked'),
        verdict('verification', 'breach'),
        verdict('sandbox', 'breach')
      ]);

      expect(selected.map(v => v.gate)).toEqual(['reviewer', 'envelope']);
    });
  });
});
