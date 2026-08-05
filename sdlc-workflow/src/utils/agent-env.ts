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
 * `process.env` minus the nested-agent markers, suitable as `spawn`'s `env`.
 *
 * @remarks
 * Deliberately a denylist, not a `CURSOR_*` wildcard: the engine *reads*
 * `CURSOR_AGENT_BIN` and `CURSOR_MODEL` from the same namespace, and dropping
 * those would silently change which binary and model every dispatch used.
 */
export const sanitizedAgentEnv = (
  base: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const key of NESTED_AGENT_ENV_KEYS) {
    delete env[key];
  }
  return env;
};
