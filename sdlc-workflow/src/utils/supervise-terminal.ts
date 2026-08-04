import type { SuperviseExitRecord } from '../repositories/supervise-exit.repository';
import { runExitCode, type RunExitInput } from './run-exit';

/** Minimal supervise outcome shape — avoids importing the service module. */
export type SuperviseTerminalOutcome = RunExitInput & {
  detail?: string;
};

/**
 * Build the terminal exit record for an intentional supervise outcome.
 *
 * Legitimate completion is only `kind: 'completed'` (all tasks merged).
 * Every other terminal state — including a process exit code of 0 with
 * incomplete work (`stopped`) — is `abnormal: true` so artifacts alone can
 * tell completion from a quiet walk-away (#38).
 */
export const exitRecordFromResult = (
  result: SuperviseTerminalOutcome
): SuperviseExitRecord => ({
  code: runExitCode(result),
  reason: result.detail ?? result.kind,
  abnormal: result.kind !== 'completed',
  at: new Date().toISOString()
});
export const exitRecordFromError = (err: unknown): SuperviseExitRecord => {
  const reason =
    err instanceof Error
      ? err.message
      : typeof err === 'string'
        ? err
        : 'unknown-error';
  return {
    code: 1,
    reason: reason.length > 0 ? reason : 'unknown-error',
    abnormal: true,
    at: new Date().toISOString()
  };
};

export const exitRecordFromSignal = (signal: string): SuperviseExitRecord => {
  // Node convention: 128 + signal number (SIGTERM=15 → 143, SIGINT=2 → 130).
  const code = signal === 'SIGINT' ? 130 : 143;
  return {
    code,
    reason: signal,
    abnormal: true,
    at: new Date().toISOString()
  };
};

/** One-line operator marker appended to `monitor.log` on termination. */
export const formatExitMonitorLine = (record: SuperviseExitRecord): string =>
  `[supervise] exit code=${record.code} reason=${record.reason} abnormal=${record.abnormal}`;

export interface SuperviseTerminalHandlers {
  /** Remove signal / exit listeners installed by {@link installSuperviseTerminalHandlers}. */
  disarm: () => void;
}

/**
 * Install process handlers so SIGTERM / SIGINT / a bare `process.exit` still
 * invoke `onTerminal` (sync FS writes only — `exit` cannot await).
 *
 * SIGKILL and power-loss cannot run handlers; the continuity daemon's
 * liveness check owns that detection boundary.
 */
export const installSuperviseTerminalHandlers = (
  onTerminal: (record: SuperviseExitRecord) => void
): SuperviseTerminalHandlers => {
  const onSignal = (signal: NodeJS.Signals): void => {
    onTerminal(exitRecordFromSignal(signal));
    process.exit(signal === 'SIGINT' ? 130 : 143);
  };

  const onExit = (code: number | null): void => {
    onTerminal({
      code: code ?? 1,
      reason: 'process-exit',
      abnormal: true,
      at: new Date().toISOString()
    });
  };

  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);
  process.on('exit', onExit);

  return {
    disarm: (): void => {
      process.off('SIGTERM', onSignal);
      process.off('SIGINT', onSignal);
      process.off('exit', onExit);
    }
  };
};
