/**
 * launchctl load-path coverage for LaunchdRepository. Isolated so
 * `child_process.spawnSync` can be mocked without affecting other suites.
 */
const spawnSync = jest.fn();

jest.mock('child_process', () => ({
  spawnSync: (...args: unknown[]) => spawnSync(...args)
}));

import { mkdtempSync } from 'fs';
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
  });

  it('throws when bootstrap fails', () => {
    spawnSync.mockImplementation((cmd: string, args: string[]) => {
      if (args[0] === 'bootstrap') {
        return { status: 1, stdout: '', stderr: 'bootstrap denied' };
      }
      return { status: 0, stdout: '', stderr: '' };
    });
    const repo = new LaunchdRepository();
    const dir = mkdtempSync(path.join(os.tmpdir(), 'daemon-launchd-fail-'));

    expect(() =>
      repo.install({
        label: 'sdlc.workflow.daemon.loadfail',
        program: process.execPath,
        programArguments: [],
        workingDirectory: dir,
        stdoutPath: path.join(dir, 'o.log'),
        stderrPath: path.join(dir, 'e.log'),
        plistDir: dir,
        load: true
      })
    ).toThrow(WorkflowError);
  });
});
