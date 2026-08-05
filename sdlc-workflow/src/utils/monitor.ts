import { appendFileSync, mkdirSync } from 'fs';
import path from 'path';

/**
 * Append one line to a run's `monitor.log`. Absent/empty path is a no-op.
 *
 * @remarks
 * Best-effort by design. The monitor log is observability, not run state, and
 * it is written from paths that must not fail — retry attempts, escalation
 * warnings, terminal exit lines. An unwritable log directory taking down an
 * otherwise healthy run would trade a missing line for a dead supervisor.
 */
export const appendMonitorLine = (
  monitorPath: string | undefined,
  line: string
): void => {
  if (monitorPath === undefined || monitorPath.length === 0) return;
  try {
    mkdirSync(path.dirname(monitorPath), { recursive: true });
    appendFileSync(monitorPath, `${line}\n`);
  } catch {
    // Nothing useful to do: reporting a logging failure needs the log.
  }
};
