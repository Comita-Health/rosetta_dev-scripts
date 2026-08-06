/**
 * launchctl load-path coverage for LaunchdRepository. Isolated so
 * `child_process.spawnSync` can be mocked without affecting other suites.
 */
const spawnSync = jest.fn();

jest.mock('child_process', () => ({
  spawnSync: (...args: unknown[]) => spawnSync(...args)
}));

import { existsSync, mkdtempSync } from 'fs';
import os from 'os';
import path from 'path';
import { LaunchdRepository } from '../repositories/launchd.repository';
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
});
