import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { appendMonitorLine } from '../utils/monitor';

describe('appendMonitorLine', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'sdlc-monitor-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('creates the run directory and appends newline-terminated lines', () => {
    const file = path.join(dir, 'nested', 'monitor.log');

    appendMonitorLine(file, 'first');
    appendMonitorLine(file, 'second');

    expect(readFileSync(file, 'utf-8')).toBe('first\nsecond\n');
  });

  it('is a no-op without a path', () => {
    expect(() => appendMonitorLine(undefined, 'x')).not.toThrow();
    expect(() => appendMonitorLine('', 'x')).not.toThrow();
  });

  it('never takes a run down over an unwritable log', () => {
    // A file where the parent directory has to be created: mkdir fails with
    // ENOTDIR. The monitor log is observability, so a healthy run must not
    // die for it — and there is nowhere to report the failure but the log.
    const blocker = path.join(dir, 'not-a-dir');
    writeFileSync(blocker, 'x');

    expect(() =>
      appendMonitorLine(path.join(blocker, 'monitor.log'), 'line')
    ).not.toThrow();
  });
});
