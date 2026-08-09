import { mkdtempSync, readFileSync, mkdirSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import {
  findWorkspaceRootWithDaemonConfig,
  parseGitHubIssueUrl,
  parseGitHubPrUrl,
  readSuperviseLaunchRecord,
  writeSuperviseLaunchRecord
} from '../utils/launch-record';

describe('launch-record', () => {
  it('writes and reads a supervise launch.json', () => {
    const runsDir = mkdtempSync(path.join(os.tmpdir(), 'launch-rec-'));
    const record = writeSuperviseLaunchRecord({
      runsDir,
      runId: 'run-a',
      argv: ['src/index.ts', 'run', '--supervise'],
      execArgv: ['--import', 'tsx'],
      execPath: '/usr/bin/node',
      cwd: '/engine',
      repoPath: '/repo',
      specPath: '/repo/spec.md',
      chronicleRepo: '/chronicle'
    });
    expect(record.runId).toBe('run-a');
    const loaded = readSuperviseLaunchRecord(runsDir, 'run-a');
    expect(loaded).toEqual(record);
    const raw = JSON.parse(
      readFileSync(path.join(runsDir, 'run-a', 'launch.json'), 'utf-8')
    ) as { argv: string[] };
    expect(raw.argv).toEqual(['src/index.ts', 'run', '--supervise']);
  });

  it('finds a workspace root with .sdlc/daemon.json', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'ws-root-'));
    mkdirSync(path.join(root, '.sdlc'), { recursive: true });
    writeFileSync(path.join(root, '.sdlc', 'daemon.json'), '{}');
    const nested = path.join(root, 'a', 'b');
    mkdirSync(nested, { recursive: true });
    expect(findWorkspaceRootWithDaemonConfig(nested)).toBe(root);
  });

  it('parses GitHub PR and issue URLs', () => {
    expect(parseGitHubPrUrl('https://github.com/Acme/widgets/pull/12')).toEqual(
      { repo: 'Acme/widgets', number: 12 }
    );
    expect(
      parseGitHubIssueUrl('https://github.com/Acme/widgets/issues/99')
    ).toEqual({ repo: 'Acme/widgets', number: 99 });
    expect(parseGitHubPrUrl('not-a-url')).toBeNull();
  });
});
