import 'reflect-metadata';
import { EventEmitter } from 'events';

jest.mock('child_process', () => ({ spawn: jest.fn() }));

import { spawn } from 'child_process';
import { AgentRunnerRepository } from '../repositories/agent-runner.repository';

const spawnMock = spawn as jest.Mock;

interface FakeChild extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill?: (signal?: string) => boolean;
}

/** Build a fake child process the repo can attach listeners to. */
const fakeChild = (): FakeChild => {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
};

/** Queue a child that emits the given streams then closes with `status`. */
const spawnResult = (
  status: number | null,
  stdout = '',
  stderr = ''
): FakeChild => {
  const child = fakeChild();
  spawnMock.mockReturnValueOnce(child);
  setImmediate(() => {
    if (stdout.length > 0) child.stdout.emit('data', Buffer.from(stdout));
    if (stderr.length > 0) child.stderr.emit('data', Buffer.from(stderr));
    child.emit('close', status);
  });
  return child;
};

describe('AgentRunnerRepository', () => {
  const repo = new AgentRunnerRepository();
  const originalModel = process.env.CURSOR_MODEL;

  afterEach(() => {
    spawnMock.mockReset();
    if (originalModel === undefined) {
      delete process.env.CURSOR_MODEL;
    } else {
      process.env.CURSOR_MODEL = originalModel;
    }
  });

  it('runs the agent in the given working directory', async () => {
    spawnResult(0, 'done');

    const result = await repo.run('/worktrees/T-01', 'implement it');

    expect(result).toEqual({ ok: true, output: 'done' });
    const [, args, options] = spawnMock.mock.calls[0];
    expect(args).toContain('implement it');
    expect(options.cwd).toBe('/worktrees/T-01');
  });

  it('returns ok=false with output on a non-zero exit', async () => {
    spawnResult(1, '', 'boom');

    await expect(repo.run('/wt', 'p')).resolves.toEqual({
      ok: false,
      output: 'boom'
    });
  });

  it('falls back to stdout when stderr is empty on failure', async () => {
    spawnResult(2, 'partial output');

    await expect(repo.run('/wt', 'p')).resolves.toEqual({
      ok: false,
      output: 'partial output'
    });
  });

  it('passes CURSOR_MODEL through as --model', async () => {
    process.env.CURSOR_MODEL = 'claude-sonnet-4-5';
    spawnResult(0, 'ok');

    await repo.run('/wt', 'p');
    const [, args] = spawnMock.mock.calls[0];
    expect(args).toContain('--model');
    expect(args).toContain('claude-sonnet-4-5');
  });

  it('throws typed when the binary cannot be started', async () => {
    const child = fakeChild();
    spawnMock.mockReturnValueOnce(child);
    setImmediate(() => child.emit('error', new Error('ENOENT')));

    await expect(repo.run('/wt', 'p')).rejects.toMatchObject({
      code: 'MISSING_API_KEY'
    });
  });

  it('does not block the event loop: two agents run concurrently', async () => {
    // Neither child closes until both have been spawned — impossible with
    // the old spawnSync implementation, required by the P3 T-01 pool.
    const first = fakeChild();
    const second = fakeChild();
    spawnMock.mockReturnValueOnce(first).mockReturnValueOnce(second);

    const runs = Promise.all([repo.run('/wt/a', 'a'), repo.run('/wt/b', 'b')]);
    await new Promise(resolve => setImmediate(resolve));
    expect(spawnMock).toHaveBeenCalledTimes(2);

    second.stdout.emit('data', Buffer.from('b done'));
    second.emit('close', 0);
    first.stdout.emit('data', Buffer.from('a done'));
    first.emit('close', 0);

    await expect(runs).resolves.toEqual([
      { ok: true, output: 'a done' },
      { ok: true, output: 'b done' }
    ]);
  });

  describe('wall-clock timeout', () => {
    const originalTimeout = process.env.SDLC_AGENT_TIMEOUT_MS;

    beforeEach(() => {
      jest.useFakeTimers();
      process.env.SDLC_AGENT_TIMEOUT_MS = '1000';
    });

    afterEach(() => {
      jest.useRealTimers();
      if (originalTimeout === undefined) {
        delete process.env.SDLC_AGENT_TIMEOUT_MS;
      } else {
        process.env.SDLC_AGENT_TIMEOUT_MS = originalTimeout;
      }
    });

    it('kills a wedged agent and resolves as a legible failure', async () => {
      const child = fakeChild();
      child.kill = jest.fn((signal: string) => {
        // Model a process that ignores SIGTERM but dies on SIGKILL.
        if (signal === 'SIGKILL') child.emit('close', null);
        return true;
      }) as unknown as FakeChild['kill'];
      spawnMock.mockReturnValueOnce(child);

      const run = repo.run('/wt', 'p');
      await jest.advanceTimersByTimeAsync(1_000);
      expect(child.kill).toHaveBeenCalledWith('SIGTERM');

      await jest.advanceTimersByTimeAsync(10_000);
      expect(child.kill).toHaveBeenCalledWith('SIGKILL');

      const result = await run;
      expect(result.ok).toBe(false);
      expect(result.output).toContain('timed out after 1s');
    });

    it('leaves a fast agent untouched', async () => {
      const child = fakeChild();
      child.kill = jest.fn() as unknown as FakeChild['kill'];
      spawnMock.mockReturnValueOnce(child);

      const run = repo.run('/wt', 'p');
      child.stdout.emit('data', Buffer.from('done'));
      child.emit('close', 0);

      await expect(run).resolves.toEqual({ ok: true, output: 'done' });
      await jest.advanceTimersByTimeAsync(60_000);
      expect(child.kill).not.toHaveBeenCalled();
    });
  });
});
