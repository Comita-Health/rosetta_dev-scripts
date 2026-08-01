import { spawnSync } from 'child_process';
import { injectable } from 'inversify';
import { WorkflowError } from '../types';

export interface AgentRunResult {
  ok: boolean;
  output: string;
}

/**
 * Runs a workspace-mutating agent (the implementation agent of
 * SPEC-PRD-0011-P2 T-01) inside a given working directory — unlike the
 * `cursor-cli` inference transport, which is sandboxed to the OS temp dir.
 */
export interface IAgentRunnerRepository {
  run(cwd: string, prompt: string): Promise<AgentRunResult>;
}

const DEFAULT_BIN = 'cursor-agent';
const MAX_BUFFER = 64 * 1024 * 1024;

@injectable()
export class AgentRunnerRepository implements IAgentRunnerRepository {
  async run(cwd: string, prompt: string): Promise<AgentRunResult> {
    const bin = process.env.CURSOR_AGENT_BIN ?? DEFAULT_BIN;
    const args = ['--trust', '-p', prompt, '--output-format', 'text'];
    const model = process.env.CURSOR_MODEL;
    if (model !== undefined && model.length > 0) {
      args.push('--model', model);
    }

    const result = spawnSync(bin, args, {
      encoding: 'utf-8',
      cwd,
      maxBuffer: MAX_BUFFER
    });

    if (result.error !== undefined) {
      throw new WorkflowError(
        `Cursor Agent CLI (${bin}) could not be started — install it and run \`${bin} login\``,
        'MISSING_API_KEY',
        [result.error.message]
      );
    }
    if (result.status !== 0) {
      return {
        ok: false,
        output: (result.stderr ?? result.stdout ?? '').slice(0, 2000)
      };
    }
    return { ok: true, output: result.stdout };
  }
}
