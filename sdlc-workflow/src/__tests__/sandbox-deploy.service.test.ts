import 'reflect-metadata';
import { mkdtempSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import { Container } from 'inversify';
import type { IContractRepository } from '../repositories/contract.repository';
import {
  DeployRecordRepository,
  IDeployRecordRepository
} from '../repositories/deploy-record.repository';
import type { IShellCommandRepository } from '../repositories/shell-command.repository';
import {
  DeployLedgerRef,
  ISandboxDeployService,
  SandboxDeployService
} from '../services/sandbox-deploy.service';
import { WORKFLOW_TOKENS } from '../tokens';
import { SandboxContract } from '../types';
import { ghEnv } from '../utils/gh-cli';

jest.mock('../utils/gh-cli', () => ({ ghEnv: jest.fn(() => ({})) }));

const ghEnvMock = ghEnv as jest.Mock;

const CONTRACT: SandboxContract = {
  deployCommand: './deploy-to-sandbox.sh',
  healthCommand: './health.sh',
  timeoutMinutes: 5
};

// The full environment configuration a repo might declare. Only the
// sandbox entry is reachable: the contract repository exposes nothing
// else and the deployer takes no environment parameter (T-03 hard
// constraint from S-04).
const PRODUCTION_SENTINEL = './deploy-to-PRODUCTION.sh';

describe('SandboxDeployService (T-03)', () => {
  let service: ISandboxDeployService;
  let loadSandbox: jest.Mock;
  let run: jest.Mock;
  // The real ledger on a temp dir, not a mock: "exactly one deploy was
  // dispatched" is a claim about what two calls agreed on through persisted
  // records, and a stubbed ledger would assert the stub instead.
  let records: IDeployRecordRepository;
  let runsDir: string;
  const runId = 'run-1';
  const ledger = (over: Partial<DeployLedgerRef> = {}): DeployLedgerRef => ({
    runsDir,
    runId,
    contentSha: 'tree-1',
    trigger: 'task',
    taskId: 'T-01',
    ...over
  });

  beforeEach(() => {
    ghEnvMock.mockReset().mockReturnValue({});
    loadSandbox = jest.fn().mockReturnValue(CONTRACT);
    run = jest.fn().mockReturnValue({ ok: true, output: 'sha=abc123 healthy' });
    records = new DeployRecordRepository();
    runsDir = mkdtempSync(path.join(os.tmpdir(), 'sdlc-sandbox-'));

    const container = new Container();
    container
      .bind<IContractRepository>(WORKFLOW_TOKENS.ContractRepository)
      .toConstantValue({ loadSandbox, loadVerification: jest.fn() });
    container
      .bind<IShellCommandRepository>(WORKFLOW_TOKENS.ShellCommandRepository)
      .toConstantValue({ run });
    container
      .bind<IDeployRecordRepository>(WORKFLOW_TOKENS.DeployRecordRepository)
      .toConstantValue(records);
    container
      .bind<ISandboxDeployService>(WORKFLOW_TOKENS.SandboxDeployService)
      .to(SandboxDeployService);
    service = container.get<ISandboxDeployService>(
      WORKFLOW_TOKENS.SandboxDeployService
    );
  });

  afterEach(() => {
    rmSync(runsDir, { recursive: true, force: true });
  });

  const deployCalls = (): unknown[] =>
    run.mock.calls.filter(call => call[1] === CONTRACT.deployCommand);

  it('deploys and passes when the health output reports the deployed SHA', async () => {
    const outcome = await service.deploy({
      worktreePath: '/wt',
      sha: 'abc123'
    });

    expect(run).toHaveBeenCalledTimes(2);
    expect(run).toHaveBeenNthCalledWith(
      1,
      '/wt',
      CONTRACT.deployCommand,
      { SDLC_SANDBOX_SHA: 'abc123' },
      5 * 60_000
    );
    expect(run).toHaveBeenNthCalledWith(
      2,
      '/wt',
      CONTRACT.healthCommand,
      { SDLC_SANDBOX_SHA: 'abc123' },
      5 * 60_000
    );
    expect(outcome.verdict).toMatchObject({ gate: 'sandbox', outcome: 'pass' });
    expect(outcome.record).toMatchObject({ sha: 'abc123', status: 'healthy' });
    expect(outcome.healthReport).toBe('sha=abc123 healthy');
  });

  // The deploy and health scripts shell out to gh. Left to inherit this
  // process's environment they get the token the operator exported at
  // launch, which expires an hour in while the run keeps going — so a
  // workflow that actually succeeded is reported as a failed deploy.
  it('hands the deploy and health commands a refreshed gh token', async () => {
    ghEnvMock.mockReturnValue({ GH_TOKEN: 'ghs_refreshed' });

    await service.deploy({ worktreePath: '/wt', sha: 'abc123' });

    for (const call of run.mock.calls) {
      expect(call[2]).toMatchObject({
        GH_TOKEN: 'ghs_refreshed',
        GITHUB_TOKEN: 'ghs_refreshed'
      });
    }
    expect(ghEnvMock).toHaveBeenCalledWith('/wt');
  });

  it('leaves the command environment alone when no gh token is available', async () => {
    ghEnvMock.mockReturnValue({});

    await service.deploy({ worktreePath: '/wt', sha: 'abc123' });

    expect(run.mock.calls[0][2]).toEqual({ SDLC_SANDBOX_SHA: 'abc123' });
  });

  it('skips the deploy command when the same SHA is already healthy (idempotent no-op)', async () => {
    const outcome = await service.deploy({
      worktreePath: '/wt',
      sha: 'abc123',
      previous: { sha: 'abc123', status: 'healthy', recordedAt: 'x' }
    });

    // Only the health command ran — the existing instance is reported.
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(
      '/wt',
      CONTRACT.healthCommand,
      { SDLC_SANDBOX_SHA: 'abc123' },
      expect.any(Number)
    );
    expect(outcome.verdict.outcome).toBe('pass');
    expect(outcome.verdict.reasons[0]).toContain('already deployed');
  });

  it('redeploys when the previous record is a different SHA or failed', async () => {
    await service.deploy({
      worktreePath: '/wt',
      sha: 'abc123',
      previous: { sha: 'old-sha', status: 'healthy', recordedAt: 'x' }
    });
    expect(run).toHaveBeenCalledWith(
      '/wt',
      CONTRACT.deployCommand,
      expect.anything(),
      expect.any(Number)
    );
  });

  it('never reaches any environment other than the sandbox, even with a full environment configuration', async () => {
    // The deployer's only source of commands is loadSandbox; a production
    // entry in .sdlc/environments.json is structurally unreachable, and
    // the deploy API offers no environment parameter to select it.
    await service.deploy({ worktreePath: '/wt', sha: 'abc123' });

    for (const call of run.mock.calls) {
      expect(call[1]).not.toBe(PRODUCTION_SENTINEL);
      expect(call[1]).not.toContain('PRODUCTION');
    }
    expect(loadSandbox).toHaveBeenCalledWith('/wt');
    const deployArgs = (service.deploy as (input: unknown) => unknown).length;
    expect(deployArgs).toBe(1); // single input object, no environment arg
  });

  it('reports blocked when the repo declares no sandbox contract', async () => {
    loadSandbox.mockReturnValue(null);

    const outcome = await service.deploy({ worktreePath: '/wt', sha: 'x' });

    expect(run).not.toHaveBeenCalled();
    expect(outcome.verdict.outcome).toBe('blocked');
    expect(outcome.record).toBeUndefined();
  });

  it('records a breach with transcript when the deploy command fails', async () => {
    run.mockReturnValueOnce({ ok: false, output: 'stack rollback' });

    const outcome = await service.deploy({ worktreePath: '/wt', sha: 'x' });

    expect(outcome.verdict).toMatchObject({
      outcome: 'breach',
      wouldEscalate: true,
      reasons: ['deploy command failed'],
      transcript: 'stack rollback'
    });
    expect(outcome.record).toMatchObject({ status: 'failed' });
  });

  it('records a breach when health output does not report the deployed SHA', async () => {
    run
      .mockReturnValueOnce({ ok: true, output: 'deployed' })
      .mockReturnValueOnce({ ok: true, output: 'healthy but no sha' });

    const outcome = await service.deploy({
      worktreePath: '/wt',
      sha: 'abc123'
    });

    expect(outcome.verdict.outcome).toBe('breach');
    expect(outcome.verdict.reasons[0]).toContain(
      'does not report deployed SHA'
    );
  });

  it('records a breach when the health command itself fails', async () => {
    run
      .mockReturnValueOnce({ ok: true, output: 'deployed' })
      .mockReturnValueOnce({ ok: false, output: '503' });

    const outcome = await service.deploy({
      worktreePath: '/wt',
      sha: 'abc123'
    });

    expect(outcome.verdict.outcome).toBe('breach');
    expect(outcome.verdict.reasons).toEqual(['health command failed']);
  });

  // SPEC-PRD-0011-P4 T-01. The engine publishes the range and stays out of the
  // path policy: what counts as deployable differs per repo, and a filter
  // baked in here would be wrong for the next consumer.
  describe('path-aware deploy range (SPEC-PRD-0011-P4 T-01)', () => {
    it('exports the base SHA to both the deploy and the health command', async () => {
      await service.deploy({
        worktreePath: '/wt',
        sha: 'abc123',
        baseSha: 'base789'
      });

      const env = {
        SDLC_SANDBOX_SHA: 'abc123',
        SDLC_SANDBOX_BASE_SHA: 'base789'
      };
      expect(run).toHaveBeenNthCalledWith(
        1,
        '/wt',
        CONTRACT.deployCommand,
        env,
        expect.any(Number)
      );
      // Health needs it too: a script that skipped the deploy for
      // non-deployable paths has to make the same decision again to know it
      // may answer without curling a live app.
      expect(run).toHaveBeenNthCalledWith(
        2,
        '/wt',
        CONTRACT.healthCommand,
        env,
        expect.any(Number)
      );
    });

    it('exports only the deployed SHA when no base is known', async () => {
      await service.deploy({ worktreePath: '/wt', sha: 'abc123' });

      for (const call of run.mock.calls) {
        expect(call[2]).toEqual({ SDLC_SANDBOX_SHA: 'abc123' });
      }
    });

    it('treats an empty base as no base at all', async () => {
      // An empty value looks "set" to `[ -n "$SDLC_SANDBOX_BASE_SHA" ]`, so a
      // script would take the range path with no range and conclude nothing
      // changed — a silent skip of a real deploy.
      await service.deploy({ worktreePath: '/wt', sha: 'abc123', baseSha: '' });

      for (const call of run.mock.calls) {
        expect(call[2]).toEqual({ SDLC_SANDBOX_SHA: 'abc123' });
      }
    });

    it('leaves already-healthy idempotency untouched when a base is supplied', async () => {
      const outcome = await service.deploy({
        worktreePath: '/wt',
        sha: 'abc123',
        baseSha: 'base789',
        previous: { sha: 'abc123', status: 'healthy', recordedAt: 'x' }
      });

      expect(run).toHaveBeenCalledTimes(1);
      expect(run).toHaveBeenCalledWith(
        '/wt',
        CONTRACT.healthCommand,
        expect.objectContaining({ SDLC_SANDBOX_BASE_SHA: 'base789' }),
        expect.any(Number)
      );
      expect(outcome.verdict.outcome).toBe('pass');
      expect(outcome.alreadyDeployed).toBe(true);
    });

    it('captures the workflow run URL the deploy script printed', async () => {
      run
        .mockReturnValueOnce({
          ok: true,
          output:
            'dispatched https://github.com/org/repo/actions/runs/12345 for abc123'
        })
        .mockReturnValueOnce({ ok: true, output: 'sha=abc123 healthy' });

      const outcome = await service.deploy({
        worktreePath: '/wt',
        sha: 'abc123'
      });

      expect(outcome.workflowRef).toBe(
        'https://github.com/org/repo/actions/runs/12345'
      );
    });

    it('leaves the workflow reference unset when the script prints none', async () => {
      const outcome = await service.deploy({
        worktreePath: '/wt',
        sha: 'abc123'
      });

      expect(outcome.workflowRef).toBeUndefined();
    });
  });

  describe('content-SHA deploy records (SPEC-PRD-0022-P1 T-01)', () => {
    it('records the dispatch and its outcome under the content SHA', async () => {
      run
        .mockReturnValueOnce({
          ok: true,
          output: 'https://github.com/org/repo/actions/runs/42'
        })
        .mockReturnValueOnce({ ok: true, output: 'sha=abc123 healthy' });

      const outcome = await service.deploy({
        worktreePath: '/wt',
        sha: 'abc123',
        ledger: ledger()
      });

      expect(records.list(runsDir, runId)).toEqual([
        expect.objectContaining({ status: 'in-flight', commitSha: 'abc123' }),
        expect.objectContaining({
          contentSha: 'tree-1',
          commitSha: 'abc123',
          trigger: 'task',
          status: 'healthy',
          workflowRef: 'https://github.com/org/repo/actions/runs/42'
        })
      ]);
      expect(outcome.record).toMatchObject({ contentSha: 'tree-1' });
    });

    it('records a failed deploy so the content is not mistaken for live', async () => {
      run.mockReturnValueOnce({ ok: false, output: 'rollback' });

      await service.deploy({
        worktreePath: '/wt',
        sha: 'abc123',
        ledger: ledger()
      });

      expect(records.latestForContent(runsDir, runId, 'tree-1')).toMatchObject({
        status: 'failed'
      });
    });

    it('redeploys content whose last deploy failed', async () => {
      run.mockReturnValueOnce({ ok: false, output: 'rollback' });
      await service.deploy({
        worktreePath: '/wt',
        sha: 'abc123',
        ledger: ledger()
      });
      run.mockClear();

      await service.deploy({
        worktreePath: '/wt',
        sha: 'def456',
        ledger: ledger()
      });

      expect(deployCalls()).toHaveLength(1);
    });

    it('writes no records at all when no ledger is supplied', async () => {
      await service.deploy({ worktreePath: '/wt', sha: 'abc123' });

      expect(records.list(runsDir, runId)).toEqual([]);
      expect(deployCalls()).toHaveLength(1);
    });
  });

  describe('merge-path dedup on content (SPEC-PRD-0022-P1 T-02)', () => {
    const deployPrHead = async (): Promise<void> => {
      run.mockReturnValue({ ok: true, output: 'sha=pr-head healthy' });
      await service.deploy({
        worktreePath: '/wt',
        sha: 'pr-head',
        ledger: ledger()
      });
      run.mockClear();
    };

    it('reuses the PR-head deploy when the merge commit carries the same tree', async () => {
      await deployPrHead();

      const outcome = await service.deploy({
        worktreePath: '/wt',
        sha: 'merge-commit',
        ledger: ledger({ trigger: 'merge', taskId: undefined })
      });

      // No deploy *and* no health probe: the live app answers with pr-head,
      // so asking it about merge-commit would fail on identical content.
      expect(run).not.toHaveBeenCalled();
      expect(outcome.verdict.outcome).toBe('pass');
      expect(outcome.verdict.reasons[0]).toContain('deploy reused');
      expect(outcome.reusedFrom).toBe('pr-head');
      expect(records.list(runsDir, runId)).toContainEqual(
        expect.objectContaining({
          status: 'reused',
          commitSha: 'merge-commit',
          reusedFrom: 'pr-head',
          trigger: 'merge'
        })
      );
    });

    it('dispatches normally when the merged tree differs from anything deployed', async () => {
      await deployPrHead();
      run.mockReturnValue({ ok: true, output: 'sha=merge-commit healthy' });

      const outcome = await service.deploy({
        worktreePath: '/wt',
        sha: 'merge-commit',
        ledger: ledger({ contentSha: 'tree-2', trigger: 'merge' })
      });

      expect(deployCalls()).toHaveLength(1);
      expect(outcome.reusedFrom).toBeUndefined();
      expect(outcome.verdict.reasons[0]).toContain('deployed and healthy');
    });

    it('keeps reusing after the first reuse, instead of dedup working once', async () => {
      await deployPrHead();
      await service.deploy({
        worktreePath: '/wt',
        sha: 'merge-commit',
        ledger: ledger({ trigger: 'merge' })
      });

      const third = await service.deploy({
        worktreePath: '/wt',
        sha: 'phase-tip',
        ledger: ledger({ trigger: 'phase-boundary' })
      });

      expect(run).not.toHaveBeenCalled();
      expect(third.reusedFrom).toBe('pr-head');
    });

    it('still health-checks its own SHA rather than reusing itself', async () => {
      await deployPrHead();
      run.mockReturnValue({ ok: true, output: 'sha=pr-head healthy' });

      // Same commit, not just same content: this is the SHA-idempotency case,
      // which verifies health rather than trusting the record.
      const outcome = await service.deploy({
        worktreePath: '/wt',
        sha: 'pr-head',
        previous: { sha: 'pr-head', status: 'healthy', recordedAt: 'x' },
        ledger: ledger()
      });

      expect(deployCalls()).toHaveLength(0);
      expect(run).toHaveBeenCalledWith(
        '/wt',
        CONTRACT.healthCommand,
        expect.anything(),
        expect.any(Number)
      );
      expect(outcome.reusedFrom).toBeUndefined();
    });
  });

  describe('phase-boundary race avoidance (SPEC-PRD-0022-P1 T-03)', () => {
    it('skips dispatch while another trigger is deploying the same content', async () => {
      // A push-triggered deploy registered itself and has not finished.
      records.begin({
        runsDir,
        runId,
        contentSha: 'tree-1',
        commitSha: 'abc123',
        trigger: 'push'
      });
      run.mockReturnValue({ ok: true, output: 'sha=abc123 healthy' });

      const outcome = await service.deploy({
        worktreePath: '/wt',
        sha: 'abc123',
        ledger: ledger({ trigger: 'phase-boundary' })
      });

      expect(deployCalls()).toHaveLength(0);
      expect(outcome.verdict.outcome).toBe('pass');
      expect(outcome.verdict.reasons[0]).toContain('dispatch skipped');
      expect(outcome.alreadyDeployed).toBe(true);
    });

    it('blocks rather than dispatching when the in-flight deploy has not landed', async () => {
      records.begin({
        runsDir,
        runId,
        contentSha: 'tree-1',
        commitSha: 'abc123',
        trigger: 'push'
      });
      run.mockReturnValue({ ok: true, output: 'serving an older sha' });

      const outcome = await service.deploy({
        worktreePath: '/wt',
        sha: 'abc123',
        ledger: ledger({ trigger: 'phase-boundary' })
      });

      // Red, so a later wave retries — a competing dispatch is never how the
      // engine finds out whether the other deploy worked.
      expect(deployCalls()).toHaveLength(0);
      expect(outcome.verdict.outcome).toBe('breach');
      expect(outcome.verdict.reasons[0]).toContain('in flight');
    });

    it('dispatches exactly one deploy when two triggers fire near-simultaneously', async () => {
      run.mockReturnValue({ ok: true, output: 'sha=abc123 healthy' });

      // Both in flight at once, not one after the other: the second call reads
      // the ledger while the first is still inside its deploy command, which
      // is the window the in-flight marker exists to cover.
      const [push, phase] = await Promise.all([
        service.deploy({
          worktreePath: '/wt',
          sha: 'abc123',
          ledger: ledger({ trigger: 'push' })
        }),
        service.deploy({
          worktreePath: '/wt',
          sha: 'abc123',
          ledger: ledger({ trigger: 'phase-boundary' })
        })
      ]);

      expect(deployCalls()).toHaveLength(1);
      expect(push.verdict.outcome).toBe('pass');
      expect(phase.verdict.outcome).toBe('pass');
      expect(phase.alreadyDeployed).toBe(true);
    });

    it('skips dispatch for a completed deploy of the same commit, without run state', async () => {
      // The engine restarted, or a different trigger deployed this exact
      // commit: run state has no sandbox record and the ledger does.
      run.mockReturnValue({ ok: true, output: 'sha=abc123 healthy' });
      await service.deploy({
        worktreePath: '/wt',
        sha: 'abc123',
        ledger: ledger({ trigger: 'push' })
      });
      run.mockClear();

      const outcome = await service.deploy({
        worktreePath: '/wt',
        sha: 'abc123',
        ledger: ledger({ trigger: 'phase-boundary' })
      });

      expect(deployCalls()).toHaveLength(0);
      expect(outcome.verdict.outcome).toBe('pass');
      expect(outcome.alreadyDeployed).toBe(true);
    });
  });
});
