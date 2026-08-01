import 'reflect-metadata';
import { Container } from 'inversify';
import type { IContractRepository } from '../repositories/contract.repository';
import type { IShellCommandRepository } from '../repositories/shell-command.repository';
import {
  ISandboxDeployService,
  SandboxDeployService
} from '../services/sandbox-deploy.service';
import { WORKFLOW_TOKENS } from '../tokens';
import { SandboxContract } from '../types';

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

  beforeEach(() => {
    loadSandbox = jest.fn().mockReturnValue(CONTRACT);
    run = jest.fn().mockReturnValue({ ok: true, output: 'sha=abc123 healthy' });

    const container = new Container();
    container
      .bind<IContractRepository>(WORKFLOW_TOKENS.ContractRepository)
      .toConstantValue({ loadSandbox, loadVerification: jest.fn() });
    container
      .bind<IShellCommandRepository>(WORKFLOW_TOKENS.ShellCommandRepository)
      .toConstantValue({ run });
    container
      .bind<ISandboxDeployService>(WORKFLOW_TOKENS.SandboxDeployService)
      .to(SandboxDeployService);
    service = container.get<ISandboxDeployService>(
      WORKFLOW_TOKENS.SandboxDeployService
    );
  });

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
});
