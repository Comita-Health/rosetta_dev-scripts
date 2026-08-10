/**
 * launchctl load-path coverage for LaunchdRepository. Isolated so
 * `child_process.spawnSync` can be mocked without affecting other suites.
 */
const spawnSync = jest.fn();

jest.mock('child_process', () => ({
  spawnSync: (...args: unknown[]) => spawnSync(...args)
}));

import { existsSync, mkdtempSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import {
  LEGACY_CONTINUITY_DAEMON_LABEL,
  LaunchdRepository
} from '../repositories/launchd.repository';
import { WorkflowError } from '../types';

describe('LaunchdRepository launchctl load', () => {
  beforeEach(() => {
    spawnSync.mockReset();
    spawnSync.mockReturnValue({ status: 0, stdout: '', stderr: '' });
  });

  it('bootstraps and enables the agent when load is true', () => {
    const repo = new LaunchdRepository();
    const dir = mkdtempSync(path.join(os.tmpdir(), 'daemon-launchd-ok-'));
    const result = repo.install({
      label: 'sdlc.workflow.daemon.loadok',
      program: process.execPath,
      programArguments: ['-e', '0'],
      workingDirectory: dir,
      stdoutPath: path.join(dir, 'o.log'),
      stderrPath: path.join(dir, 'e.log'),
      plistDir: dir,
      load: true
    });

    expect(result.loaded).toBe(true);
    expect(spawnSync.mock.calls.some(c => c[1]?.[0] === 'bootstrap')).toBe(
      true
    );
    expect(spawnSync.mock.calls.some(c => c[1]?.[0] === 'enable')).toBe(true);
    expect(existsSync(result.plistPath)).toBe(true);
  });

  it('throws and removes the plist when bootstrap fails', () => {
    spawnSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'bootstrap') {
        return { status: 1, stdout: '', stderr: 'bootstrap denied' };
      }
      return { status: 0, stdout: '', stderr: '' };
    });
    const repo = new LaunchdRepository();
    const dir = mkdtempSync(path.join(os.tmpdir(), 'daemon-launchd-fail-'));
    const label = 'sdlc.workflow.daemon.loadfail';
    const plistPath = path.join(dir, `${label}.plist`);

    expect(() =>
      repo.install({
        label,
        program: process.execPath,
        programArguments: [],
        workingDirectory: dir,
        stdoutPath: path.join(dir, 'o.log'),
        stderrPath: path.join(dir, 'e.log'),
        plistDir: dir,
        load: true
      })
    ).toThrow(WorkflowError);
    expect(existsSync(plistPath)).toBe(false);
  });

  it('boots out and removes the plist when enable fails after bootstrap', () => {
    spawnSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'enable') {
        return { status: 1, stdout: '', stderr: 'enable denied' };
      }
      return { status: 0, stdout: '', stderr: '' };
    });
    const repo = new LaunchdRepository();
    const dir = mkdtempSync(path.join(os.tmpdir(), 'daemon-launchd-enable-'));
    const label = 'sdlc.workflow.daemon.enablefail';
    const plistPath = path.join(dir, `${label}.plist`);

    expect(() =>
      repo.install({
        label,
        program: process.execPath,
        programArguments: [],
        workingDirectory: dir,
        stdoutPath: path.join(dir, 'o.log'),
        stderrPath: path.join(dir, 'e.log'),
        plistDir: dir,
        load: true
      })
    ).toThrow(/launchctl enable failed/);

    // Pre-clean bootout before bootstrap, plus rollback bootout after enable.
    const bootoutCalls = spawnSync.mock.calls.filter(
      (c: unknown[]) => Array.isArray(c[1]) && c[1][0] === 'bootout'
    );
    expect(bootoutCalls.length).toBeGreaterThanOrEqual(2);
    expect(existsSync(plistPath)).toBe(false);
  });

  /**
   * When launchctl cannot be executed at all, spawnSync reports `status: null`
   * with empty streams — the spawn error is the only actionable cause, so it
   * must reach the operator rather than being dropped.
   */
  it('surfaces the spawn error when launchctl cannot be executed', () => {
    spawnSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'bootstrap') {
        return {
          status: null,
          stdout: null,
          stderr: null,
          error: new Error('spawnSync launchctl ENOENT')
        };
      }
      return { status: 0, stdout: '', stderr: '' };
    });
    const repo = new LaunchdRepository();
    const dir = mkdtempSync(path.join(os.tmpdir(), 'daemon-launchd-enoent-'));
    const label = 'sdlc.workflow.daemon.enoent';
    const plistPath = path.join(dir, `${label}.plist`);

    let thrown: WorkflowError | undefined;
    try {
      repo.install({
        label,
        program: process.execPath,
        programArguments: [],
        workingDirectory: dir,
        stdoutPath: path.join(dir, 'o.log'),
        stderrPath: path.join(dir, 'e.log'),
        plistDir: dir,
        load: true
      });
    } catch (error) {
      thrown = error as WorkflowError;
    }

    expect(thrown).toBeInstanceOf(WorkflowError);
    expect(thrown?.code).toBe('DAEMON_CONFIG_INVALID');
    expect(thrown?.details).toEqual(['spawnSync launchctl ENOENT']);
    expect(existsSync(plistPath)).toBe(false);
  });

  it('reports a non-zero exit with no output without a blank detail', () => {
    spawnSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'bootstrap') {
        return { status: 5, stdout: '   ', stderr: '' };
      }
      return { status: 0, stdout: '', stderr: '' };
    });
    const repo = new LaunchdRepository();
    const dir = mkdtempSync(path.join(os.tmpdir(), 'daemon-launchd-silent-'));

    let thrown: WorkflowError | undefined;
    try {
      repo.install({
        label: 'sdlc.workflow.daemon.silent',
        program: process.execPath,
        programArguments: [],
        workingDirectory: dir,
        stdoutPath: path.join(dir, 'o.log'),
        stderrPath: path.join(dir, 'e.log'),
        plistDir: dir,
        load: true
      });
    } catch (error) {
      thrown = error as WorkflowError;
    }

    expect(thrown).toBeInstanceOf(WorkflowError);
    expect(thrown?.details).toEqual([]);
  });

  it('uninstallLegacyContinuityDaemon bootouts and removes the StartInterval plist', () => {
    const repo = new LaunchdRepository();
    const dir = mkdtempSync(path.join(os.tmpdir(), 'daemon-launchd-legacy-'));
    const legacyPath = path.join(
      dir,
      `${LEGACY_CONTINUITY_DAEMON_LABEL}.plist`
    );
    writeFileSync(legacyPath, '<plist/>StartInterval</plist>\n', 'utf-8');

    repo.uninstallLegacyContinuityDaemon(dir);

    expect(existsSync(legacyPath)).toBe(false);
    expect(
      spawnSync.mock.calls.some(
        c =>
          Array.isArray(c[1]) &&
          c[1][0] === 'bootout' &&
          String(c[1][1]).endsWith(`/${LEGACY_CONTINUITY_DAEMON_LABEL}`)
      )
    ).toBe(true);
  });
});
