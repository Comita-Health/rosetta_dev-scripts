import 'reflect-metadata';

jest.mock('child_process', () => ({ spawnSync: jest.fn() }));

import { spawnSync } from 'child_process';
import { AgentRunnerRepository } from '../repositories/agent-runner.repository';

const spawnMock = spawnSync as jest.Mock;

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
    spawnMock.mockReturnValue({ status: 0, stdout: 'done', stderr: '' });

    const result = await repo.run('/worktrees/T-01', 'implement it');

    expect(result).toEqual({ ok: true, output: 'done' });
    const [, args, options] = spawnMock.mock.calls[0];
    expect(args).toContain('implement it');
    expect(options.cwd).toBe('/worktrees/T-01');
  });

  it('returns ok=false with output on a non-zero exit', async () => {
    spawnMock.mockReturnValue({ status: 1, stdout: '', stderr: 'boom' });

    await expect(repo.run('/wt', 'p')).resolves.toEqual({
      ok: false,
      output: 'boom'
    });
  });

  it('falls back to stdout when stderr is missing on failure', async () => {
    spawnMock.mockReturnValue({
      status: 2,
      stdout: 'partial output',
      stderr: undefined
    });

    await expect(repo.run('/wt', 'p')).resolves.toEqual({
      ok: false,
      output: 'partial output'
    });
  });

  it('passes CURSOR_MODEL through as --model', async () => {
    process.env.CURSOR_MODEL = 'claude-sonnet-4-5';
    spawnMock.mockReturnValue({ status: 0, stdout: 'ok', stderr: '' });

    await repo.run('/wt', 'p');
    const [, args] = spawnMock.mock.calls[0];
    expect(args).toContain('--model');
    expect(args).toContain('claude-sonnet-4-5');
  });

  it('throws typed when the binary cannot be started', async () => {
    spawnMock.mockReturnValue({ error: new Error('ENOENT') });

    await expect(repo.run('/wt', 'p')).rejects.toMatchObject({
      code: 'MISSING_API_KEY'
    });
  });
});
