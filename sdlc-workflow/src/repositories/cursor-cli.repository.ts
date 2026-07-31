import { spawnSync } from 'child_process';
import { injectable } from 'inversify';
import os from 'os';
import { WorkflowError } from '../types';
import type { IModelRepository } from './model.repository';

const DEFAULT_BIN = 'cursor-agent';
const MAX_BUFFER = 32 * 1024 * 1024;

/**
 * Completion transport backed by the operator's logged-in Cursor Agent CLI
 * session (`cursor-agent -p`), the same operator-auth pattern team-setup
 * uses with `gh`. Runs from the OS temp dir so `--trust` grants the agent
 * nothing beyond an empty scratch directory.
 */
@injectable()
export class CursorCliRepository implements IModelRepository {
  async complete(prompt: string): Promise<string> {
    const bin = process.env.CURSOR_AGENT_BIN ?? DEFAULT_BIN;
    const args = ['--trust', '-p', prompt, '--output-format', 'text'];
    const model = process.env.CURSOR_MODEL;
    if (model !== undefined && model.length > 0) {
      args.push('--model', model);
    }

    const result = spawnSync(bin, args, {
      encoding: 'utf-8',
      cwd: os.tmpdir(),
      maxBuffer: MAX_BUFFER
    });

    if (result.error !== undefined) {
      throw new WorkflowError(
        `Cursor Agent CLI (${bin}) could not be started — install it and run \`${bin} login\`, or set ANTHROPIC_API_KEY to use the API backend`,
        'MISSING_API_KEY',
        [result.error.message]
      );
    }
    if (result.status !== 0) {
      throw new WorkflowError(
        `Cursor Agent CLI exited with status ${result.status}`,
        'INFERENCE_FAILED',
        [(result.stderr ?? '').slice(0, 500)]
      );
    }

    const text = result.stdout.trim();
    if (text.length === 0) {
      throw new WorkflowError(
        'Cursor Agent CLI returned an empty response',
        'INFERENCE_FAILED'
      );
    }
    return text;
  }
}
