import { spawnSync } from 'child_process';
import { mkdtempSync } from 'fs';
import os from 'os';
import path from 'path';

/**
 * End-to-end proof for the fail-loud exit-code criterion (#37 / #38): the
 * real CLI — not a mocked service — must exit non-zero when the spec does
 * not exist, in both plain and detached invocations. This is the exact
 * observed bug (silent exit 0 for a missing spec) closed by T-01/T-02.
 */
const CLI = path.resolve(__dirname, '..', 'index.ts');
const PKG = path.resolve(__dirname, '..', '..');

const runCli = (extraArgs: string[]): ReturnType<typeof spawnSync> => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'sdlc-cli-exit-'));
  return spawnSync(
    'bunx',
    [
      'tsx',
      CLI,
      'run',
      '--spec',
      path.join(tmp, 'does-not-exist-spec.md'),
      '--repo',
      tmp,
      '--runs-dir',
      tmp,
      '--run-id',
      'cli-exit-e2e',
      ...extraArgs
    ],
    { cwd: PKG, encoding: 'utf-8', timeout: 60_000 }
  );
};

describe('CLI exit codes for a missing spec (e2e)', () => {
  it('plain run exits non-zero', () => {
    const result = runCli([]);
    expect(result.status).not.toBe(0);
    expect(result.status).not.toBeNull();
  }, 90_000);

  it('detach parent exits non-zero when the child dies during startup', () => {
    const result = runCli(['--detach']);
    expect(result.status).not.toBe(0);
    expect(result.status).not.toBeNull();
  }, 90_000);
});
