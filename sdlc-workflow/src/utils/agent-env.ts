import os from 'os';
import path from 'path';

/**
 * Environment variables that mark "you are already running inside an agent
 * session" and must never reach a nested agent (SPEC-PRD-0021-P1 T-05).
 *
 * A `cursor-agent` that inherits `CURSOR_AGENT` from the orchestrator can
 * decide it is a re-entrant invocation and exit without doing the work — a
 * silent no-op that looks like a successful dispatch and is indistinguishable
 * from "the agent had nothing to change". Every subsequent gate then judges
 * an unmodified branch.
 *
 * The askpass pair is stripped for a different reason: it points at the
 * *parent* session's credential channel, so a child that needs git auth would
 * prompt a UI attached to the wrong process and hang until the step timed out.
 */
export const NESTED_AGENT_ENV_KEYS = [
  'CURSOR_AGENT',
  'CURSOR_INVOKED_AS',
  'CURSOR_CONVERSATION_ID',
  'CURSOR_ASKPASS_SOCKET',
  'CURSOR_ASKPASS_SECRET',
  'AGENT_TRANSCRIPTS',
  // Claude Code's equivalent marker — this workspace is dual-tool.
  'CLAUDECODE',
  'CLAUDE_CODE'
] as const;

/**
 * Built-in Cursor data root for engine-spawned agents
 * (SPEC-BUG-agent-history-isolation-P1 T-01).
 *
 * Stable across runs so operators can resume a wedged session with one
 * `CURSOR_DATA_DIR=… cursor-agent ls` command. Override with
 * `SDLC_AGENT_DATA_DIR` when engine state lives elsewhere.
 */
export const defaultAgentDataDir = (): string =>
  path.join(os.homedir(), '.rosetta', 'agent-data');

/**
 * `process.env` minus the nested-agent markers, suitable as `spawn`'s `env`.
 *
 * @remarks
 * Deliberately a denylist, not a `CURSOR_*` wildcard: the engine *reads*
 * `CURSOR_AGENT_BIN` and `CURSOR_MODEL` from the same namespace, and dropping
 * those would silently change which binary and model every dispatch used.
 *
 * Always sets `CURSOR_DATA_DIR` to the engine agent-data root so dispatch
 * transcripts never land in the operator's `~/.cursor` history. An inherited
 * `CURSOR_DATA_DIR` is overridden on purpose — that value *is* the operator
 * history root. `CURSOR_CONFIG_DIR` and other credential-bearing variables
 * are left untouched so dispatches stay authenticated.
 */
export const sanitizedAgentEnv = (
  base: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const key of NESTED_AGENT_ENV_KEYS) {
    delete env[key];
  }
  const override = env.SDLC_AGENT_DATA_DIR;
  env.CURSOR_DATA_DIR =
    typeof override === 'string' && override.length > 0
      ? override
      : defaultAgentDataDir();
  return env;
};
