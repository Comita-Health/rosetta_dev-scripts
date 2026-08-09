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

  it('derives repo/spec/chronicle from argv flags when omitted', () => {
    const runsDir = mkdtempSync(path.join(os.tmpdir(), 'launch-flags-'));
    const record = writeSuperviseLaunchRecord({
      runsDir,
      runId: 'run-b',
      argv: [
        'src/index.ts',
        'run',
        '--repo=/derived/repo',
        '--spec=/derived/spec.md',
        '--chronicle-repo=/derived/chronicle',
        '--supervise'
      ],
      execArgv: [],
      execPath: '/usr/bin/node',
      cwd: '/engine'
    });
    expect(record.repoPath).toBe('/derived/repo');
    expect(record.specPath).toBe('/derived/spec.md');
    expect(record.chronicleRepo).toBe('/derived/chronicle');
  });

  it('derives --repo / --spec from space-separated argv flags', () => {
    const runsDir = mkdtempSync(path.join(os.tmpdir(), 'launch-sp-'));
    const record = writeSuperviseLaunchRecord({
      runsDir,
      runId: 'run-c',
      argv: [
        'src/index.ts',
        'run',
        '--repo',
        '/space/repo',
        '--spec',
        '/space/spec.md',
        '--supervise'
      ],
      execArgv: [],
      execPath: '/node',
      cwd: '/cwd'
    });
    expect(record.repoPath).toBe('/space/repo');
    expect(record.specPath).toBe('/space/spec.md');
  });

  it('defaults execArgv/execPath/cwd from the process when omitted', () => {
    const runsDir = mkdtempSync(path.join(os.tmpdir(), 'launch-def-'));
    const record = writeSuperviseLaunchRecord({
      runsDir,
      runId: 'run-d',
      argv: ['src/index.ts', 'run', '-r', '/short/repo', '--supervise']
    });
    expect(record.execPath).toBe(process.execPath);
    expect(record.execArgv).toEqual([...process.execArgv]);
    expect(record.cwd).toBe(process.cwd());
    expect(record.repoPath).toBe('/short/repo');
    expect(record.specPath).toBe('');
  });

  it('returns null for missing or corrupt launch.json', () => {
    const runsDir = mkdtempSync(path.join(os.tmpdir(), 'launch-miss-'));
    expect(readSuperviseLaunchRecord(runsDir, 'absent')).toBeNull();
    mkdirSync(path.join(runsDir, 'bad'), { recursive: true });
    writeFileSync(path.join(runsDir, 'bad', 'launch.json'), '{not-json');
    expect(readSuperviseLaunchRecord(runsDir, 'bad')).toBeNull();
  });

  it('finds a workspace root with .sdlc/daemon.json', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'ws-root-'));
    mkdirSync(path.join(root, '.sdlc'), { recursive: true });
    writeFileSync(path.join(root, '.sdlc', 'daemon.json'), '{}');
    const nested = path.join(root, 'a', 'b');
    mkdirSync(nested, { recursive: true });
    expect(findWorkspaceRootWithDaemonConfig(nested)).toBe(root);
  });

  it('returns null when no ancestor has daemon.json', () => {
    const orphan = mkdtempSync(path.join(os.tmpdir(), 'ws-orphan-'));
    expect(findWorkspaceRootWithDaemonConfig(orphan)).toBeNull();
  });

  it('parses GitHub PR and issue URLs', () => {
    expect(parseGitHubPrUrl('https://github.com/Acme/widgets/pull/12')).toEqual(
      { repo: 'Acme/widgets', number: 12 }
    );
    expect(
      parseGitHubIssueUrl('https://github.com/Acme/widgets/issues/99')
    ).toEqual({ repo: 'Acme/widgets', number: 99 });
    expect(parseGitHubPrUrl('not-a-url')).toBeNull();
    expect(parseGitHubIssueUrl('https://example.com/issues/1')).toBeNull();
  });
});
