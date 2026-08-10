/**
 * Exit-code mapping for the per-workspace daemon (SPEC-PRD-0020-P2 T-04).
 *
 * Success (clean SIGTERM/SIGINT shutdown after a healthy run) is the only
 * exit 0. Fatal bootstrap and unrecoverable tick failures exit non-zero so
 * launchd KeepAlive restarts the process. KeepAlive itself stays
 * launchd-owned — this helper never arms an in-process restart loop.
 */

export type DaemonExitReason =
  'success' | 'fatal-bootstrap' | 'unrecoverable-tick';

export const DAEMON_FATAL_EXIT_CODE = 1 as const;

export const daemonExitCode = (reason: DaemonExitReason): 0 | 1 => {
  if (reason === 'success') {
    return 0;
  }
  return DAEMON_FATAL_EXIT_CODE;
};

export type DaemonExitFn = (code: number) => void;

/**
 * Log a fatal daemon failure and exit non-zero.
 *
 * @remarks
 * Production `process.exit` does not return. When `exitFn` is mocked in tests
 * (and therefore returns), this still returns `never` to callers so the
 * failure path cannot be typed as a successful completion.
 */
export const exitDaemonFatal = (
  reason: Exclude<DaemonExitReason, 'success'>,
  detail: string,
  exitFn: DaemonExitFn = code => {
    process.exit(code);
  }
): never => {
  console.error(`[daemon] ${reason}: ${detail}`);
  exitFn(daemonExitCode(reason));
  return undefined as never;
};
