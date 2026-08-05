/**
 * Map a run/supervise outcome to the CLI exit code (#37 / fail-loud T-01).
 *
 * Non-zero for every terminal state an operator must react to: a failed
 * supervise loop (which includes a refused intake — the blocked wave maps to
 * `kind: 'failed'`), a wave that ended blocked, or any task-level failure.
 * `detached` is handled by the caller before this mapping (the parent exits
 * 0 once the child is confirmed alive).
 *
 * A `stopped` outcome with incomplete tasks may still exit 0 — the
 * `supervise.exit` record's `abnormal` flag distinguishes that from
 * legitimate all-merged completion (#38 / fail-loud T-02).
 */
export interface RunExitInput {
  kind: 'detached' | 'completed' | 'stopped' | 'failed';
  lastWave?: {
    outcome: 'blocked' | 'no-ready-task' | 'executed';
    tasks: { kind: string }[];
  };
}

export const runExitCode = (result: RunExitInput): 0 | 1 => {
  if (result.kind === 'failed') {
    return 1;
  }
  const last = result.lastWave;
  if (last === undefined) {
    return 0;
  }
  if (last.outcome === 'blocked') {
    return 1;
  }
  if (last.tasks.some(task => task.kind === 'failed')) {
    return 1;
  }
  return 0;
};
