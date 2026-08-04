import { mkdtempSync, readFileSync, existsSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { SuperviseExitRepository } from '../repositories/supervise-exit.repository';
import { WakeInboxRepository } from '../repositories/wake-inbox.repository';
import {
  exitRecordFromError,
  exitRecordFromResult,
  formatExitMonitorLine
} from '../utils/supervise-terminal';

describe('SuperviseExitRepository', () => {
  it('round-trips a JSON exit record', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'sdlc-exit-'));
    const repo = new SuperviseExitRepository();
    const written = {
      code: 1,
      reason: 'boom',
      abnormal: true,
      at: '2026-08-04T00:00:00.000Z'
    };
    repo.write(dir, written);
    expect(repo.read(dir)).toEqual(written);
  });

  it('accepts a bare integer left by the continuity daemon probe', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'sdlc-exit-'));
    const repo = new SuperviseExitRepository();
    writeFileSync(path.join(dir, 'supervise.exit'), '0\n');
    expect(repo.read(dir)).toEqual(
      expect.objectContaining({ code: 0, abnormal: false })
    );
  });
});

describe('WakeInboxRepository', () => {
  it('writes a pending wake JSON file under the wake root', () => {
    const wakeDir = mkdtempSync(path.join(os.tmpdir(), 'sdlc-wake-'));
    const repo = new WakeInboxRepository();
    const file = repo.emit({
      kind: 'sdlc_supervisor',
      dedupeKey: 'run-1-exit',
      prompt: 'exited',
      data: { runId: 'run-1', code: 1 },
      wakeDir
    });
    expect(existsSync(file)).toBe(true);
    const body = JSON.parse(readFileSync(file, 'utf-8')) as {
      kind: string;
      dedupeKey: string;
      data: { code: number };
    };
    expect(body.kind).toBe('sdlc_supervisor');
    expect(body.dedupeKey).toBe('run-1-exit');
    expect(body.data.code).toBe(1);
  });
});

describe('supervise-terminal helpers', () => {
  it('marks completed as normal and stopped as abnormal', () => {
    expect(
      exitRecordFromResult({
        kind: 'completed',
        detail: 'all-tasks-merged'
      })
    ).toEqual(
      expect.objectContaining({
        code: 0,
        reason: 'all-tasks-merged',
        abnormal: false
      })
    );
    expect(
      exitRecordFromResult({
        kind: 'stopped',
        detail: 'no-ready-task'
      })
    ).toEqual(
      expect.objectContaining({
        code: 0,
        reason: 'no-ready-task',
        abnormal: true
      })
    );
  });

  it('formats a monitor exit line and error records', () => {
    const fromErr = exitRecordFromError(new Error('boom'));
    expect(fromErr.code).toBe(1);
    expect(fromErr.reason).toBe('boom');
    expect(formatExitMonitorLine(fromErr)).toBe(
      '[supervise] exit code=1 reason=boom abnormal=true'
    );
  });
});
