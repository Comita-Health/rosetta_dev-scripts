import { spawn } from 'child_process';
import { injectable } from 'inversify';
import { WorkflowError } from '../types';
import { sanitizedAgentEnv } from '../utils/agent-env';

export interface AgentRunResult {
  ok: boolean;
  output: string;
}

/**
 * Runs a workspace-mutating agent (the implementation agent of
 * SPEC-PRD-0011-P2 T-01) inside a given working directory — unlike the
 * `cursor-cli` inference transport, which is sandboxed to the OS temp dir.
 *
 * Asynchronous (`spawn`, not `spawnSync`) so the SPEC-PRD-0011-P3 T-01
 * task pool can fan agents out concurrently without blocking the event
 * loop.
 *
 * @remarks
 * Every dispatch runs with a sanitized environment (SPEC-PRD-0021-P1 T-05).
 * The spec scopes this to retries, but the failure mode — a nested agent that
 * silently no-ops on an inherited `CURSOR_AGENT` — is identical on a first
 * attempt, and a no-op that only the retry path guards against is a bug
 * waiting for the first attempt to hit it.
 */
export interface IAgentRunnerRepository {
  run(cwd: string, prompt: string): Promise<AgentRunResult>;
}

const DEFAULT_BIN = 'cursor-agent';
const MAX_BUFFER = 64 * 1024 * 1024;

/**
 * Wall-clock ceiling for one agent dispatch. `spawn` has no implicit timeout,
 * so an agent that wedges (waiting on a prompt, stuck in a tool loop) would
 * otherwise hold its wave open forever: the supervisor never advances, the
 * heartbeat keeps claiming `agentAlive`, and the run stalls with no error.
 * Override with `SDLC_AGENT_TIMEOUT_MS`.
 */
const DEFAULT_TIMEOUT_MS = 45 * 60_000;
/** Grace period between SIGTERM and SIGKILL. */
const KILL_GRACE_MS = 10_000;

const timeoutMs = (): number => {
  const raw = Number(process.env.SDLC_AGENT_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MS;
};

@injectable()
export class AgentRunnerRepository implements IAgentRunnerRepository {
  async run(cwd: string, prompt: string): Promise<AgentRunResult> {
    const bin = process.env.CURSOR_AGENT_BIN ?? DEFAULT_BIN;
    const args = ['--trust', '-p', prompt, '--output-format', 'text'];
    const model = process.env.CURSOR_MODEL;
    if (model !== undefined && model.length > 0) {
      args.push('--model', model);
    }

    const limitMs = timeoutMs();

    return new Promise<AgentRunResult>((resolve, reject) => {
      const child = spawn(bin, args, { cwd, env: sanitizedAgentEnv() });
      let stdout = '';
      let stderr = '';
      let timedOut = false;

      const killTimer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        // SIGKILL only if SIGTERM was ignored — a wedged agent often is.
        setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS).unref();
      }, limitMs);
      killTimer.unref();

      const settle = (result: AgentRunResult): void => {
        clearTimeout(killTimer);
        resolve(result);
      };

      child.stdout.on('data', (chunk: Buffer) => {
        if (stdout.length < MAX_BUFFER) stdout += chunk.toString('utf-8');
      });
      child.stderr.on('data', (chunk: Buffer) => {
        if (stderr.length < MAX_BUFFER) stderr += chunk.toString('utf-8');
      });
      child.on('error', (err: Error) => {
        clearTimeout(killTimer);
        reject(
          new WorkflowError(
            `Cursor Agent CLI (${bin}) could not be started — install it and run \`${bin} login\``,
            'MISSING_API_KEY',
            [err.message]
          )
        );
      });
      child.on('close', (status: number | null) => {
        if (timedOut) {
          // A timeout is a failure with a legible cause, not a crash: the
          // caller records it as a task failure and the run keeps moving.
          settle({
            ok: false,
            output: `agent timed out after ${Math.round(limitMs / 1000)}s and was killed\n${stderr.slice(0, 2000)}`
          });
          return;
        }
        if (status !== 0) {
          const output = stderr.length > 0 ? stderr : stdout;
          settle({ ok: false, output: output.slice(0, 2000) });
          return;
        }
        settle({ ok: true, output: stdout });
      });
    });
  }
}
