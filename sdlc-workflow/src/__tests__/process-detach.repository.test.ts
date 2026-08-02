import { mkdtempSync } from 'fs';
import os from 'os';
import path from 'path';

const unref = jest.fn();
const spawn = jest.fn();

jest.mock('child_process', () => ({
  spawn: (...args: unknown[]) => spawn(...args)
}));

describe('ProcessDetachRepository', () => {
  beforeEach(() => {
    jest.resetModules();
    spawn.mockReset();
    unref.mockReset();
  });

  it('spawns detached with file stdio and returns the pid', () => {
    spawn.mockReturnValue({ pid: 9991, unref });
    const {
      ProcessDetachRepository
    } = require('../repositories/process-detach.repository');
    const repo = new ProcessDetachRepository();
    const dir = mkdtempSync(path.join(os.tmpdir(), 'detach-'));
    const logPath = path.join(dir, 'out.log');

    const result = repo.spawnDetached({
      command: process.execPath,
      args: ['-e', 'process.exit(0)'],
      cwd: dir,
      logPath,
      env: { ...process.env, DETACH_TEST: '1' }
    });

    expect(result.pid).toBe(9991);
    expect(spawn).toHaveBeenCalledWith(
      process.execPath,
      ['-e', 'process.exit(0)'],
      expect.objectContaining({
        cwd: dir,
        detached: true,
        stdio: ['ignore', expect.any(Number), expect.any(Number)]
      })
    );
    expect(unref).toHaveBeenCalled();
  });

  it('throws when spawn yields no pid', () => {
    spawn.mockReturnValue({ pid: undefined, unref });
    const {
      ProcessDetachRepository
    } = require('../repositories/process-detach.repository');
    const repo = new ProcessDetachRepository();
    const dir = mkdtempSync(path.join(os.tmpdir(), 'detach-'));

    expect(() =>
      repo.spawnDetached({
        command: 'false',
        args: [],
        cwd: dir,
        logPath: path.join(dir, 'x.log')
      })
    ).toThrow(/no pid/);
  });

  it('defaults env to process.env when omitted', () => {
    spawn.mockReturnValue({ pid: 1, unref });
    const {
      ProcessDetachRepository
    } = require('../repositories/process-detach.repository');
    const repo = new ProcessDetachRepository();
    const dir = mkdtempSync(path.join(os.tmpdir(), 'detach-'));

    repo.spawnDetached({
      command: 'true',
      args: [],
      cwd: dir,
      logPath: path.join(dir, 'y.log')
    });

    expect(spawn.mock.calls[0][2].env).toBe(process.env);
  });
});
