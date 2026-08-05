import 'reflect-metadata';

jest.mock('child_process', () => ({ spawnSync: jest.fn() }));

import { spawnSync } from 'child_process';
import os from 'os';
import { CursorCliRepository } from '../repositories/cursor-cli.repository';

const spawnMock = spawnSync as jest.Mock;

describe('CursorCliRepository', () => {
  const repo = new CursorCliRepository();
  const originalBin = process.env.CURSOR_AGENT_BIN;
  const originalModel = process.env.CURSOR_MODEL;

  afterEach(() => {
    spawnMock.mockReset();
    if (originalBin === undefined) {
      delete process.env.CURSOR_AGENT_BIN;
    } else {
      process.env.CURSOR_AGENT_BIN = originalBin;
    }
    if (originalModel === undefined) {
      delete process.env.CURSOR_MODEL;
    } else {
      process.env.CURSOR_MODEL = originalModel;
    }
  });

  it('returns trimmed stdout from a successful run in the OS temp dir', async () => {
    delete process.env.CURSOR_MODEL;
    spawnMock.mockReturnValue({ status: 0, stdout: ' hello \n', stderr: '' });

    await expect(repo.complete('hi')).resolves.toBe('hello');
    const [bin, args, options] = spawnMock.mock.calls[0];
    expect(bin).toBe('cursor-agent');
    expect(args).toEqual(['--trust', '-p', 'hi', '--output-format', 'text']);
    expect(options.cwd).toBe(os.tmpdir());
  });

  it('honours CURSOR_AGENT_BIN and CURSOR_MODEL overrides', async () => {
    process.env.CURSOR_AGENT_BIN = '/opt/bin/agent';
    process.env.CURSOR_MODEL = 'claude-sonnet-4-5';
    spawnMock.mockReturnValue({ status: 0, stdout: 'ok', stderr: '' });

    await expect(repo.complete('hi')).resolves.toBe('ok');
    const [bin, args] = spawnMock.mock.calls[0];
    expect(bin).toBe('/opt/bin/agent');
    expect(args).toContain('--model');
    expect(args).toContain('claude-sonnet-4-5');
  });

  it('fails typed when the binary cannot be started', async () => {
    spawnMock.mockReturnValue({ error: new Error('ENOENT') });

    await expect(repo.complete('hi')).rejects.toMatchObject({
      code: 'MISSING_API_KEY',
      details: ['ENOENT']
    });
  });

  it('fails typed on a non-zero exit, carrying stderr', async () => {
    spawnMock.mockReturnValue({
      status: 1,
      stdout: '',
      stderr: 'not logged in'
    });

    await expect(repo.complete('hi')).rejects.toMatchObject({
      code: 'INFERENCE_FAILED',
      details: ['not logged in']
    });
  });

  it('reports a non-zero exit that produced no stderr at all', async () => {
    // `spawnSync` omits stderr when the child is killed by a signal; reading
    // it unguarded turned a CLI failure into an unrelated TypeError.
    spawnMock.mockReturnValue({ status: 137, stdout: '' });

    await expect(repo.complete('hi')).rejects.toMatchObject({
      code: 'INFERENCE_FAILED',
      details: ['']
    });
  });

  it('fails typed on empty output', async () => {
    spawnMock.mockReturnValue({ status: 0, stdout: '  \n', stderr: '' });

    await expect(repo.complete('hi')).rejects.toMatchObject({
      code: 'INFERENCE_FAILED'
    });
  });

  // SPEC-PRD-0021-P1 T-05. This transport carries the reviewer, verifier and
  // decompose prompts; an inherited nested-agent marker surfaces here as the
  // empty-output failure above, which reads as a model problem.
  it('completes without the orchestrator nested-agent flags', async () => {
    process.env.CURSOR_AGENT = '1';
    process.env.CLAUDECODE = '1';
    spawnMock.mockReturnValue({ status: 0, stdout: 'ok', stderr: '' });
    try {
      await repo.complete('hi');

      const [, , options] = spawnMock.mock.calls[0];
      expect(options.env.CURSOR_AGENT).toBeUndefined();
      expect(options.env.CLAUDECODE).toBeUndefined();
      expect(options.env.PATH).toBe(process.env.PATH);
    } finally {
      delete process.env.CURSOR_AGENT;
      delete process.env.CLAUDECODE;
    }
  });
});
