import { appendFileSync, mkdirSync } from 'fs';
import path from 'path';

/** Append one line to a run's `monitor.log`. Absent/empty path is a no-op. */
export const appendMonitorLine = (
  monitorPath: string | undefined,
  line: string
): void => {
  if (monitorPath === undefined || monitorPath.length === 0) return;
  mkdirSync(path.dirname(monitorPath), { recursive: true });
  appendFileSync(monitorPath, `${line}\n`);
};
