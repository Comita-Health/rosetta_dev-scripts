import { existsSync, readFileSync } from 'fs';
import { injectable } from 'inversify';
import path from 'path';
import { SandboxContract, VerificationContract, WorkflowError } from '../types';

const DEFAULT_TIMEOUT_MINUTES = 45;

/**
 * Loads the repo-owned SDLC contracts from `.sdlc/`:
 *
 * - `environments.json` — an environment map; **only the `sandbox` entry is
 *   ever read**. There is deliberately no API to fetch any other
 *   environment, so no code path through the deployer can reach a target
 *   beyond the sandbox (SPEC-PRD-0011-P2 T-03 hard constraint from S-04).
 * - `verification.json` — the scripted-check command for test-tier
 *   acceptance criteria (T-04).
 *
 * A missing file resolves to null: the corresponding gate reports itself
 * blocked rather than failing the run.
 */
export interface IContractRepository {
  loadSandbox(repoPath: string): SandboxContract | null;
  loadVerification(repoPath: string): VerificationContract | null;
}

const readJson = (file: string): Record<string, unknown> | null => {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf-8')) as Record<string, unknown>;
  } catch (err) {
    throw new WorkflowError(`Malformed JSON in ${file}`, 'CONTRACT_MALFORMED', [
      err instanceof Error ? err.message : String(err)
    ]);
  }
};

@injectable()
export class ContractRepository implements IContractRepository {
  loadSandbox(repoPath: string): SandboxContract | null {
    const environments = readJson(
      path.join(repoPath, '.sdlc', 'environments.json')
    );
    if (environments === null) return null;

    const sandbox = environments.sandbox as
      Partial<SandboxContract> | undefined;
    if (sandbox === undefined) return null;

    if (
      typeof sandbox.deployCommand !== 'string' ||
      typeof sandbox.healthCommand !== 'string'
    ) {
      throw new WorkflowError(
        'Sandbox contract requires string deployCommand and healthCommand',
        'CONTRACT_MALFORMED'
      );
    }
    return {
      deployCommand: sandbox.deployCommand,
      healthCommand: sandbox.healthCommand,
      timeoutMinutes:
        typeof sandbox.timeoutMinutes === 'number'
          ? sandbox.timeoutMinutes
          : DEFAULT_TIMEOUT_MINUTES
    };
  }

  loadVerification(repoPath: string): VerificationContract | null {
    const contract = readJson(
      path.join(repoPath, '.sdlc', 'verification.json')
    );
    if (contract === null) return null;
    if (typeof contract.testCommand !== 'string') {
      throw new WorkflowError(
        'Verification contract requires a string testCommand',
        'CONTRACT_MALFORMED'
      );
    }
    return { testCommand: contract.testCommand };
  }
}
