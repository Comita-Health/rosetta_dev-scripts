import { inject, injectable } from 'inversify';
import type { IContractRepository } from '../repositories/contract.repository';
import type { IShellCommandRepository } from '../repositories/shell-command.repository';
import { WORKFLOW_TOKENS } from '../tokens';
import { GateVerdict, SandboxRecord } from '../types';

export interface SandboxDeployInput {
  /** Worktree of the task branch — contract and commands run from here. */
  worktreePath: string;
  /** Commit SHA being deployed; exported as SDLC_SANDBOX_SHA. */
  sha: string;
  /** Prior sandbox record from run state, for SHA idempotency. */
  previous?: SandboxRecord;
}

export interface SandboxDeployOutcome {
  verdict: GateVerdict;
  record?: SandboxRecord;
  /** Health command output — the verifier agent's sandbox interface. */
  healthReport?: string;
}

/**
 * SPEC-PRD-0011-P2 T-03: deploy the task branch build to the sandbox via
 * the repo-owned contract (`.sdlc/environments.json` → `sandbox`).
 *
 * - Idempotent per SHA: a SHA already recorded healthy skips the deploy
 *   command and re-verifies health only.
 * - Health must report the deployed SHA: the health command's output has
 *   to contain `SDLC_SANDBOX_SHA` verbatim.
 * - No path beyond the sandbox: the contract repository exposes only the
 *   sandbox entry, and this service takes no environment parameter.
 */
export interface ISandboxDeployService {
  deploy(input: SandboxDeployInput): Promise<SandboxDeployOutcome>;
}

@injectable()
export class SandboxDeployService implements ISandboxDeployService {
  constructor(
    @inject(WORKFLOW_TOKENS.ContractRepository)
    private readonly _contractRepo: IContractRepository,
    @inject(WORKFLOW_TOKENS.ShellCommandRepository)
    private readonly _shellRepo: IShellCommandRepository
  ) {}

  async deploy(input: SandboxDeployInput): Promise<SandboxDeployOutcome> {
    const now = (): string => new Date().toISOString();
    const contract = this._contractRepo.loadSandbox(input.worktreePath);
    if (contract === null) {
      return {
        verdict: {
          gate: 'sandbox',
          outcome: 'blocked',
          wouldEscalate: false,
          reasons: [
            'no sandbox contract (.sdlc/environments.json → sandbox) in the repo'
          ],
          recordedAt: now()
        }
      };
    }

    const env = { SDLC_SANDBOX_SHA: input.sha };
    const timeoutMs = contract.timeoutMinutes * 60_000;
    const alreadyDeployed =
      input.previous?.sha === input.sha && input.previous.status === 'healthy';

    if (!alreadyDeployed) {
      const deploy = this._shellRepo.run(
        input.worktreePath,
        contract.deployCommand,
        env,
        timeoutMs
      );
      if (!deploy.ok) {
        return {
          verdict: {
            gate: 'sandbox',
            outcome: 'breach',
            wouldEscalate: true,
            reasons: ['deploy command failed'],
            transcript: deploy.output.slice(0, 4000),
            recordedAt: now()
          },
          record: { sha: input.sha, status: 'failed', recordedAt: now() }
        };
      }
    }

    const health = this._shellRepo.run(
      input.worktreePath,
      contract.healthCommand,
      env,
      timeoutMs
    );
    if (!health.ok || !health.output.includes(input.sha)) {
      return {
        verdict: {
          gate: 'sandbox',
          outcome: 'breach',
          wouldEscalate: true,
          reasons: [
            health.ok
              ? `health output does not report deployed SHA ${input.sha}`
              : 'health command failed'
          ],
          transcript: health.output.slice(0, 4000),
          recordedAt: now()
        },
        record: { sha: input.sha, status: 'failed', recordedAt: now() }
      };
    }

    return {
      verdict: {
        gate: 'sandbox',
        outcome: 'pass',
        wouldEscalate: false,
        reasons: alreadyDeployed
          ? [
              `already deployed at ${input.sha} — deploy skipped, health verified`
            ]
          : [`deployed and healthy at ${input.sha}`],
        recordedAt: now()
      },
      record: { sha: input.sha, status: 'healthy', recordedAt: now() },
      healthReport: health.output
    };
  }
}
