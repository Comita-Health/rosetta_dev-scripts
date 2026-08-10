import 'reflect-metadata';
import { Container } from 'inversify';
import type { IAgentRunnerRepository } from '../repositories/agent-runner.repository';
import type { IGitRepository } from '../repositories/git.repository';
import type { IRunStateRepository } from '../repositories/run-state.repository';
import {
  GATE_FIX_ATTEMPT_LIMIT,
  type GateRemediationOutcome
} from '../services/gate-remediation.service';
import {
  classifyOperatorUnstickOutcome,
  OPERATOR_UNSTICK_ATTEMPT_LIMIT,
  OperatorUnstickService,
  IOperatorUnstickService,
  shouldDispatchOperatorUnstick,
  suppressesBlockingEscalate
} from '../services/operator-unstick.service';
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

describe('OperatorUnstickService (SPEC-PRD-0025-P1 T-03)', () => {
  let service: IOperatorUnstickService;
  let state: RunState;
  let agentRun: jest.Mock;
  let headSha: jest.Mock;
  let push: jest.Mock;
  let status: jest.Mock;
  let diffStat: jest.Mock;
  let diffText: jest.Mock;
  let recordOperatorUnstickAttempt: jest.Mock;
  let recordOperatorUnstickOutcome: jest.Mock;
  let recordEscalateTier: jest.Mock;
  let recordTokenSpend: jest.Mock;
  let save: jest.Mock;
  let load: jest.Mock;

  const input = (over: Record<string, unknown> = {}) => ({
    worktreePath: '/runs/run-1/worktrees/T-01',
    branch: 'sdlc/run-1/T-01',
    task: makeTask(),
    envelope: makeEnvelope(),
    runsDir: '/runs',
    state,
    verdicts: [verdict('reviewer', 'breach', ['stale tip'])],
    budgetK: 200,
    ...over
  });

  beforeEach(() => {
    state = makeState();
    agentRun = jest
      .fn()
      .mockResolvedValue({ ok: true, output: 'OUTCOME: cleared\nrebased tip' });
    headSha = jest
      .fn()
      .mockReturnValueOnce('before-sha')
      .mockReturnValue('after-sha');
    push = jest.fn();
    status = jest.fn().mockReturnValue('');
    diffStat = jest.fn().mockReturnValue({ files: [], totalLines: 0 });
    diffText = jest.fn().mockReturnValue('');
    recordOperatorUnstickAttempt = jest
      .fn()
      .mockImplementation((_d, s: RunState, taskId: string) => {
        s.operatorUnstickAttempts[taskId] =
          (s.operatorUnstickAttempts[taskId] ?? 0) + 1;
        return s.operatorUnstickAttempts[taskId];
      });
    recordOperatorUnstickOutcome = jest.fn();
    recordEscalateTier = jest
      .fn()
      .mockImplementation((_d, s: RunState, taskId: string, tier) => {
        s.escalateTiers[taskId] = tier;
      });
    recordTokenSpend = jest
      .fn()
      .mockImplementation((_d, s: RunState, delta: number) => {
        s.tokenSpendK = (s.tokenSpendK ?? 0) + delta;
        return s.tokenSpendK;
      });
    save = jest.fn();
    // Default: disk mirrors the in-memory state (no subprocess merge).
    load = jest.fn().mockImplementation(() => state);

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
        addWorktree: jest.fn(),
        diffStat,
        diffText,
        fetch: jest.fn(),
        defaultBranch: jest.fn(),
        readAtRef: jest.fn(),
        removeWorktree: jest.fn(),
        removeWorktreeAsync: jest.fn(),
        revParse: jest.fn(),
        stageAll: jest.fn(),
        commit: jest.fn()
      } as unknown as IGitRepository);
    container
      .bind<IRunStateRepository>(WORKFLOW_TOKENS.RunStateRepository)
      .toConstantValue({
        load,
        recordOperatorUnstickAttempt,
        recordOperatorUnstickOutcome,
        recordEscalateTier,
        recordTokenSpend,
        save
      } as unknown as IRunStateRepository);
    container
      .bind<IOperatorUnstickService>(WORKFLOW_TOKENS.OperatorUnstickService)
      .to(OperatorUnstickService);
    service = container.get(WORKFLOW_TOKENS.OperatorUnstickService);
  });

  it('dispatches a headless unstick agent (cwd + prompt only — no chat/session)', async () => {
    const outcome = await service.unstick(input());

    expect(outcome).toMatchObject({ kind: 'cleared', attempt: 1 });
    expect(agentRun).toHaveBeenCalledTimes(1);
    expect(agentRun.mock.calls[0][0]).toBe('/runs/run-1/worktrees/T-01');
    const prompt = agentRun.mock.calls[0][1] as string;
    expect(prompt).toContain('Operator mandate');
    expect(prompt).toContain('no chat/session');
    expect(prompt).not.toContain('respond by TRIMMING the change');
    // AgentRunnerRepository.run(cwd, prompt) — no session argument.
    expect(agentRun.mock.calls[0]).toHaveLength(2);
  });

  it('sets escalate tier to unstick-in-flight before the agent turn', async () => {
    const tiers: string[] = [];
    recordEscalateTier.mockImplementation(
      (_d, s: RunState, taskId: string, tier: string) => {
        s.escalateTiers[taskId] = tier as RunState['escalateTiers'][string];
        tiers.push(tier);
      }
    );

    await service.unstick(input());

    expect(tiers[0]).toBe('unstick-in-flight');
    expect(recordOperatorUnstickAttempt).toHaveBeenCalled();
  });

  it('records cleared outcome and drops the in-flight tier when the blocker clears', async () => {
    const outcome = await service.unstick(input());

    expect(outcome.kind).toBe('cleared');
    expect(recordOperatorUnstickOutcome).toHaveBeenCalledWith(
      '/runs',
      state,
      'T-01',
      'cleared',
      expect.stringContaining('cleared')
    );
    expect(state.escalateTiers['T-01']).toBeUndefined();
    expect(save).toHaveBeenCalled();
    expect(push).toHaveBeenCalledWith(
      '/runs/run-1/worktrees/T-01',
      'sdlc/run-1/T-01'
    );
  });

  it('classifies record-merge evidence on run state as cleared', async () => {
    headSha.mockReset().mockReturnValue('same-sha');
    agentRun.mockResolvedValue({
      ok: true,
      output: 'recorded out-of-band merge via record-merge'
    });
    state.taskResults = {
      'T-01': {
        taskId: 'T-01',
        status: 'completed',
        branch: 'sdlc/run-1/T-01',
        worktreePath: '/runs/run-1/worktrees/T-01',
        mergedSha: 'merge-sha',
        recordedAt: 'x'
      }
    };

    const outcome = await service.unstick(input());

    expect(outcome.kind).toBe('cleared');
  });

  it('reloads mergedSha from disk after the agent turn (subprocess record-merge)', async () => {
    // In-memory state has no merge; subprocess record-merge wrote disk only.
    headSha.mockReset().mockReturnValue('same-sha');
    agentRun.mockResolvedValue({
      ok: true,
      output: 'OUTCOME: cleared — recorded out-of-band merge via record-merge'
    });
    state.taskResults = {
      'T-01': {
        taskId: 'T-01',
        status: 'completed',
        branch: 'sdlc/run-1/T-01',
        worktreePath: '/runs/run-1/worktrees/T-01',
        recordedAt: 'x'
      }
    };
    load.mockImplementation(() => ({
      ...state,
      mergedSha: 'disk-merge-sha',
      taskResults: {
        'T-01': {
          ...state.taskResults['T-01'],
          mergedSha: 'disk-merge-sha'
        }
      }
    }));

    const outcome = await service.unstick(input());

    expect(load).toHaveBeenCalledWith('/runs', 'run-1');
    expect(outcome.kind).toBe('cleared');
    expect(state.taskResults['T-01'].mergedSha).toBe('disk-merge-sha');
    expect(state.mergedSha).toBe('disk-merge-sha');
    expect(suppressesBlockingEscalate(outcome.kind)).toBe(true);
  });

  it('records authority-bound and sets halted-escalated without clearing the wave', async () => {
    headSha.mockReset().mockReturnValue('same-sha');
    agentRun.mockResolvedValue({
      ok: true,
      output: 'OUTCOME: authority-bound — cannot Draft→Approved mid-run'
    });

    const outcome = await service.unstick(input());

    expect(outcome.kind).toBe('authority-bound');
    expect(recordEscalateTier).toHaveBeenCalledWith(
      '/runs',
      state,
      'T-01',
      'halted-escalated'
    );
    expect(suppressesBlockingEscalate(outcome.kind)).toBe(false);
  });

  it('records abstained so the caller can escalate ACTION REQUIRED', async () => {
    headSha.mockReset().mockReturnValue('same-sha');
    agentRun.mockResolvedValue({
      ok: true,
      output: 'OUTCOME: abstained — cannot clear safely'
    });

    const outcome = await service.unstick(input());

    expect(outcome.kind).toBe('abstained');
    expect(recordOperatorUnstickOutcome).toHaveBeenCalledWith(
      '/runs',
      state,
      'T-01',
      'abstained',
      expect.any(String)
    );
  });

  it('returns exhausted without dispatching when the unstick budget is spent', async () => {
    state.operatorUnstickAttempts = {
      'T-01': OPERATOR_UNSTICK_ATTEMPT_LIMIT
    };

    const outcome = await service.unstick(input());

    expect(outcome).toMatchObject({ kind: 'exhausted' });
    expect(agentRun).not.toHaveBeenCalled();
    expect(recordEscalateTier).toHaveBeenCalledWith(
      '/runs',
      state,
      'T-01',
      'halted-escalated'
    );
  });

  it('skips when the envelope token budget is already spent', async () => {
    state.tokenSpendK = 250;

    const outcome = await service.unstick(input({ budgetK: 200 }));

    expect(outcome).toMatchObject({ kind: 'skipped' });
    expect(outcome.detail).toContain('budget exhausted');
    expect(agentRun).not.toHaveBeenCalled();
  });

  it('routes a specs/ policy-rewrite dirty worktree to abstained', async () => {
    headSha.mockReset().mockReturnValue('same-sha');
    status.mockReturnValue(' M specs/PRD-0025/phase-1-spec.md\n');
    agentRun.mockResolvedValue({
      ok: true,
      output: 'flipped checkboxes to clear the gate'
    });

    const outcome = await service.unstick(input());

    expect(outcome.kind).toBe('abstained');
  });

  it('routes a committed mid-run specs/** rewrite (clean tree) to abstained', async () => {
    // Committed rewrite leaves porcelain clean; HEAD still moved. Must not
    // classify as cleared via headMoved — that is the silent-policy hole.
    status.mockReturnValue('');
    diffStat.mockReturnValue({
      files: [{ path: 'specs/PRD-0025/phase-1-spec.md', lines: 4 }],
      totalLines: 4
    });
    agentRun.mockResolvedValue({
      ok: true,
      output: 'OUTCOME: cleared — flipped closeout checkboxes'
    });

    const outcome = await service.unstick(input());

    expect(outcome.kind).toBe('abstained');
    expect(diffStat).toHaveBeenCalledWith(
      '/runs/run-1/worktrees/T-01',
      'before-sha',
      'after-sha'
    );
    expect(suppressesBlockingEscalate(outcome.kind)).toBe(false);
  });

  it('routes a committed envelope-limit rewrite in the diff text to abstained', async () => {
    status.mockReturnValue('');
    diffStat.mockReturnValue({
      files: [{ path: 'sdlc-workflow/src/types.ts', lines: 2 }],
      totalLines: 2
    });
    diffText.mockReturnValue(
      '--- a/x\n+++ b/x\n@@\n-maxDiffLines: 400\n+maxDiffLines: 99999\n'
    );
    agentRun.mockResolvedValue({
      ok: true,
      output: 'OUTCOME: cleared — raised maxDiffLines'
    });

    const outcome = await service.unstick(input());

    expect(outcome.kind).toBe('abstained');
  });

  it('does not treat a bare cleared marker without blocker-clear evidence as cleared', async () => {
    headSha.mockReset().mockReturnValue('same-sha');
    agentRun.mockResolvedValue({
      ok: true,
      output: 'OUTCOME: cleared'
    });

    const outcome = await service.unstick(input());

    expect(outcome.kind).toBe('abstained');
    expect(suppressesBlockingEscalate(outcome.kind)).toBe(false);
  });

  it('does not clear from cleared marker + resume wording without durable state', async () => {
    headSha.mockReset().mockReturnValue('same-sha');
    agentRun.mockResolvedValue({
      ok: true,
      output: 'OUTCOME: cleared — resume path ready via launch.json'
    });

    const outcome = await service.unstick(input());

    expect(outcome.kind).toBe('abstained');
    expect(suppressesBlockingEscalate(outcome.kind)).toBe(false);
  });

  it('does not treat "not yet cleared … resume later" as a cleared marker', async () => {
    headSha.mockReset().mockReturnValue('same-sha');
    agentRun.mockResolvedValue({
      ok: true,
      output: 'not yet cleared — will resume later'
    });

    const outcome = await service.unstick(input());

    expect(outcome.kind).toBe('abstained');
    expect(suppressesBlockingEscalate(outcome.kind)).toBe(false);
  });

  it('meters token spend even when the agent dispatch throws', async () => {
    agentRun.mockRejectedValue(new Error('transport died'));
    headSha.mockReset().mockReturnValue('before-sha');

    const outcome = await service.unstick(input());

    expect(recordTokenSpend).toHaveBeenCalled();
    expect(outcome.kind).toBe('abstained');
    expect(outcome.detail).toContain('transport died');
  });

  it('skips when there are no remediable gate findings', async () => {
    const outcome = await service.unstick(
      input({ verdicts: [verdict('verification', 'breach')] })
    );

    expect(outcome).toMatchObject({ kind: 'skipped' });
    expect(agentRun).not.toHaveBeenCalled();
  });

  it('records risky-proceed and sets advisory-risky tier', async () => {
    headSha.mockReset().mockReturnValue('same-sha');
    agentRun.mockResolvedValue({
      ok: true,
      output: 'OUTCOME: risky-proceed — continuing with advisory'
    });

    const outcome = await service.unstick(input());

    expect(outcome.kind).toBe('risky-proceed');
    expect(recordEscalateTier).toHaveBeenCalledWith(
      '/runs',
      state,
      'T-01',
      'advisory-risky'
    );
    expect(suppressesBlockingEscalate(outcome.kind)).toBe(true);
  });

  it('routes policy-rewrite + risky-proceed marker to risky-proceed', async () => {
    status.mockReturnValue(' M specs/PRD-0025/phase-1-spec.md\n');
    headSha.mockReset().mockReturnValue('same-sha');
    agentRun.mockResolvedValue({
      ok: true,
      output: 'OUTCOME: risky-proceed — left dirty specs, advisory only'
    });

    const outcome = await service.unstick(input());

    expect(outcome.kind).toBe('risky-proceed');
  });

  it('does not treat HEAD move as clear evidence when push fails', async () => {
    push.mockImplementation(() => {
      throw new Error('remote rejected');
    });
    agentRun.mockResolvedValue({
      ok: true,
      output: 'OUTCOME: cleared — rebased tip'
    });

    const outcome = await service.unstick(input());

    expect(outcome.kind).toBe('abstained');
    expect(outcome.detail).toContain('push failed');
  });

  it('classifies empty failed agent dispatch without inventing a clear', async () => {
    headSha.mockReset().mockReturnValue('same-sha');
    agentRun.mockResolvedValue({ ok: false, output: '' });

    const outcome = await service.unstick(input());

    expect(outcome.kind).toBe('abstained');
    expect(outcome.detail).toContain('agent dispatch failed');
  });

  it('fail-closes committed-range inspection errors to abstained (not cleared)', async () => {
    diffStat.mockImplementation(() => {
      throw new Error('git diff failed');
    });
    agentRun.mockResolvedValue({
      ok: true,
      output: 'OUTCOME: cleared — rebased tip'
    });

    const outcome = await service.unstick(input());

    // HEAD moved but the committed range cannot be audited — must not
    // suppress ACTION REQUIRED (a specs/** rewrite may be invisible).
    expect(outcome.kind).toBe('abstained');
    expect(suppressesBlockingEscalate(outcome.kind)).toBe(false);
  });

  it('fail-closes status() failures to abstained (not cleared)', async () => {
    status.mockImplementation(() => {
      throw new Error('status unavailable');
    });
    agentRun.mockResolvedValue({
      ok: true,
      output: 'OUTCOME: cleared — rebased tip'
    });

    const outcome = await service.unstick(input());

    expect(outcome.kind).toBe('abstained');
    expect(suppressesBlockingEscalate(outcome.kind)).toBe(false);
  });
});

describe('shouldDispatchOperatorUnstick', () => {
  const state = makeState({
    gateFixAttempts: { 'T-01': GATE_FIX_ATTEMPT_LIMIT }
  });
  const remediable = [verdict('reviewer', 'breach')];

  it('dispatches after gate-fix attempts are exhausted for remediable findings', () => {
    const remediation: GateRemediationOutcome = {
      kind: 'skipped',
      attempt: 2,
      detail: 'gate-fix attempts exhausted (2/2)'
    };
    expect(
      shouldDispatchOperatorUnstick(remediation, remediable, state, 'T-01')
    ).toBe(true);
  });

  it('does not dispatch when remediation succeeded', () => {
    const remediation: GateRemediationOutcome = {
      kind: 'remediated',
      attempt: 1,
      sha: 'x',
      detail: 'ok'
    };
    expect(
      shouldDispatchOperatorUnstick(remediation, remediable, state, 'T-01')
    ).toBe(false);
  });

  it('does not dispatch for non-remediable skips', () => {
    const remediation: GateRemediationOutcome = {
      kind: 'skipped',
      attempt: 0,
      detail: 'no remediable gate findings'
    };
    expect(
      shouldDispatchOperatorUnstick(
        remediation,
        [verdict('verification', 'breach')],
        makeState(),
        'T-01'
      )
    ).toBe(false);
  });

  it('does not dispatch while gate-fix attempts remain', () => {
    const remediation: GateRemediationOutcome = {
      kind: 'failed',
      attempt: 1,
      detail: 'remediation agent produced no commit'
    };
    expect(
      shouldDispatchOperatorUnstick(
        remediation,
        remediable,
        makeState({ gateFixAttempts: { 'T-01': 1 } }),
        'T-01'
      )
    ).toBe(false);
  });
});

describe('classifyOperatorUnstickOutcome', () => {
  const base = {
    attempt: 1,
    attemptLimit: 2,
    taskMerged: false,
    headMoved: false,
    policyRewriteAttempt: false
  };

  it('prefers explicit authority-bound markers', () => {
    expect(
      classifyOperatorUnstickOutcome({
        ...base,
        agentOutput: 'OUTCOME: authority-bound — PHI'
      })
    ).toBe('authority-bound');
  });

  it('treats merge evidence as cleared', () => {
    expect(
      classifyOperatorUnstickOutcome({
        ...base,
        agentOutput: 'done',
        taskMerged: true
      })
    ).toBe('cleared');
  });

  it('treats cleared marker + HEAD move as rebase/tip clear evidence', () => {
    expect(
      classifyOperatorUnstickOutcome({
        ...base,
        agentOutput: 'OUTCOME: cleared — rebased tip',
        headMoved: true
      })
    ).toBe('cleared');
  });

  it('does not clear from a bare cleared marker alone', () => {
    expect(
      classifyOperatorUnstickOutcome({
        ...base,
        agentOutput: 'OUTCOME: cleared'
      })
    ).toBe('abstained');
  });

  it('does not clear from HEAD movement alone', () => {
    expect(
      classifyOperatorUnstickOutcome({
        ...base,
        agentOutput: 'rewrote something',
        headMoved: true
      })
    ).toBe('abstained');
  });

  it('routes policy-rewrite attempts to abstained even with clear claims', () => {
    expect(
      classifyOperatorUnstickOutcome({
        ...base,
        agentOutput: 'OUTCOME: cleared — edited specs',
        headMoved: true,
        policyRewriteAttempt: true
      })
    ).toBe('abstained');
  });

  it('does not clear from cleared marker + resume wording alone', () => {
    expect(
      classifyOperatorUnstickOutcome({
        ...base,
        agentOutput: 'OUTCOME: cleared — resume path ready via launch.json'
      })
    ).toBe('abstained');
  });

  it('does not clear from "not yet cleared … resume later"', () => {
    expect(
      classifyOperatorUnstickOutcome({
        ...base,
        agentOutput: 'not yet cleared — will resume later',
        headMoved: true
      })
    ).toBe('abstained');
  });

  it('classifies abstain naming smoke/veto as authority-bound', () => {
    expect(
      classifyOperatorUnstickOutcome({
        ...base,
        agentOutput: 'abstained — cannot waive live smoke / veto'
      })
    ).toBe('authority-bound');
  });

  it('marks the last attempt exhausted when nothing cleared', () => {
    expect(
      classifyOperatorUnstickOutcome({
        ...base,
        attempt: 2,
        agentOutput: 'still stuck'
      })
    ).toBe('exhausted');
  });
});

describe('suppressesBlockingEscalate', () => {
  it('suppresses only cleared and risky-proceed', () => {
    expect(suppressesBlockingEscalate('cleared')).toBe(true);
    expect(suppressesBlockingEscalate('risky-proceed')).toBe(true);
    expect(suppressesBlockingEscalate('abstained')).toBe(false);
    expect(suppressesBlockingEscalate('authority-bound')).toBe(false);
    expect(suppressesBlockingEscalate('exhausted')).toBe(false);
    expect(suppressesBlockingEscalate('skipped')).toBe(false);
  });
});
