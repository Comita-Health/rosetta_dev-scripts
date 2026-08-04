import { mkdtempSync, readFileSync, existsSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { SuperviseExitRepository } from '../repositories/supervise-exit.repository';
import { WakeInboxRepository } from '../repositories/wake-inbox.repository';
import {
  exitRecordFromError,
  exitRecordFromResult,
  exitRecordFromSignal,
  formatExitMonitorLine,
  installSuperviseTerminalHandlers
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
    writeFileSync(path.join(dir, 'supervise.exit'), '1\n');
    expect(repo.read(dir)).toEqual(
      expect.objectContaining({ code: 1, abnormal: true })
    );
  });

  it('returns null when the exit file is missing or incomplete', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'sdlc-exit-'));
    const repo = new SuperviseExitRepository();
    expect(repo.read(dir)).toBeNull();

    writeFileSync(path.join(dir, 'supervise.exit'), '{"code":1}\n');
    expect(repo.read(dir)).toBeNull();

    writeFileSync(path.join(dir, 'supervise.exit'), 'not-json{\n');
    expect(repo.read(dir)).toBeNull();
  });
});

describe('WakeInboxRepository', () => {
  const originalWake = process.env.ROSETTA_WAKE_DIR;

  afterEach(() => {
    if (originalWake === undefined) {
      delete process.env.ROSETTA_WAKE_DIR;
    } else {
      process.env.ROSETTA_WAKE_DIR = originalWake;
    }
  });

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

  it('defaults data to {} and resolves root from ROSETTA_WAKE_DIR', () => {
    const wakeDir = mkdtempSync(path.join(os.tmpdir(), 'sdlc-wake-env-'));
    process.env.ROSETTA_WAKE_DIR = wakeDir;
    const repo = new WakeInboxRepository();
    // Omit wakeDir + data so emit uses ROSETTA_WAKE_DIR and `data ?? {}`.
    const file = repo.emit({
      kind: 'sdlc_supervisor',
      dedupeKey: 'env-root',
      prompt: 'exited'
    });
    expect(file.startsWith(path.join(wakeDir, 'pending'))).toBe(true);
    const body = JSON.parse(readFileSync(file, 'utf-8')) as {
      data: Record<string, unknown>;
    };
    expect(body.data).toEqual({});
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

  it('falls back to kind when detail is omitted', () => {
    expect(exitRecordFromResult({ kind: 'failed' })).toEqual(
      expect.objectContaining({
        code: 1,
        reason: 'failed',
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

  it('maps string / non-Error / empty-message throwables', () => {
    expect(exitRecordFromError('plain-string').reason).toBe('plain-string');
    expect(exitRecordFromError(42).reason).toBe('unknown-error');
    expect(exitRecordFromError(new Error('')).reason).toBe('unknown-error');
  });

  it('maps SIGINT and SIGTERM to Node exit codes', () => {
    expect(exitRecordFromSignal('SIGINT')).toEqual(
      expect.objectContaining({ code: 130, reason: 'SIGINT', abnormal: true })
    );
    expect(exitRecordFromSignal('SIGTERM')).toEqual(
      expect.objectContaining({ code: 143, reason: 'SIGTERM', abnormal: true })
    );
  });

  it('installs signal and exit handlers that invoke onTerminal', () => {
    const onTerminal = jest.fn();
    const exitSpy = jest
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined) as never);

    const handlers = installSuperviseTerminalHandlers(onTerminal);

    process.emit('SIGINT', 'SIGINT');
    expect(onTerminal).toHaveBeenCalledWith(
      expect.objectContaining({ code: 130, reason: 'SIGINT' })
    );
    expect(exitSpy).toHaveBeenCalledWith(130);

    onTerminal.mockClear();
    process.emit('SIGTERM', 'SIGTERM');
    expect(onTerminal).toHaveBeenCalledWith(
      expect.objectContaining({ code: 143, reason: 'SIGTERM' })
    );
    expect(exitSpy).toHaveBeenCalledWith(143);

    onTerminal.mockClear();
    process.emit('exit', null);
    expect(onTerminal).toHaveBeenCalledWith(
      expect.objectContaining({ code: 1, reason: 'process-exit' })
    );

    onTerminal.mockClear();
    process.emit('exit', 0);
    expect(onTerminal).toHaveBeenCalledWith(
      expect.objectContaining({ code: 0, reason: 'process-exit' })
    );

    handlers.disarm();
    exitSpy.mockRestore();
  });
});
