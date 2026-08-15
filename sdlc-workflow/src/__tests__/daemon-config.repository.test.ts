import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync
} from 'fs';
import os from 'os';
import path from 'path';
import { DaemonConfigRepository } from '../repositories/daemon-config.repository';
import { WorkflowError } from '../types';

const writeDaemonConfig = (
  root: string,
  overrides: Record<string, unknown> = {}
): void => {
  mkdirSync(path.join(root, '.sdlc'), { recursive: true });
  writeFileSync(
    path.join(root, '.sdlc', 'daemon.json'),
    JSON.stringify({
      activateScript: 'scripts/activate.sh',
      runsDir: 'var/runs',
      defaultPollSeconds: 30,
      headlessRunner: 'test-runner',
      ...overrides
    }),
    'utf-8'
  );
};

describe('DaemonConfigRepository', () => {
  const repo = new DaemonConfigRepository();

  it('loads DaemonConfig from the workspace contract and derives unique paths', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'daemon-cfg-a-'));
    writeDaemonConfig(root);

    const { config, paths } = repo.load(root);

    expect(config.workspaceRoot).toBe(path.resolve(root));
    expect(config.activateScript).toBe(
      path.resolve(root, 'scripts/activate.sh')
    );
    expect(config.runsDir).toBe(path.resolve(root, 'var/runs'));
    expect(config.defaultPollSeconds).toBe(30);
    expect(config.headlessRunner).toBe('test-runner');
    expect(config.operator).toBeUndefined();
    expect(paths.pidFile).toBe(
      path.join(root, '.sdlc', 'daemon', 'daemon.pid')
    );
    expect(paths.logPath).toBe(
      path.join(root, '.sdlc', 'daemon', 'daemon.log')
    );
    expect(paths.launchdLabel).toMatch(
      /^sdlc\.workflow\.daemon\.[a-f0-9]{16}$/
    );
  });

  it('derives distinct pid/log/label for two workspace roots', () => {
    const a = mkdtempSync(path.join(os.tmpdir(), 'daemon-cfg-b-'));
    const b = mkdtempSync(path.join(os.tmpdir(), 'daemon-cfg-c-'));
    writeDaemonConfig(a);
    writeDaemonConfig(b);

    const left = repo.load(a);
    const right = repo.load(b);

    expect(left.paths.pidFile).not.toBe(right.paths.pidFile);
    expect(left.paths.logPath).not.toBe(right.paths.logPath);
    expect(left.paths.launchdLabel).not.toBe(right.paths.launchdLabel);
  });

  it('rejects an empty workspace root without writing state', () => {
    const probe = mkdtempSync(path.join(os.tmpdir(), 'daemon-cfg-empty-'));
    const before = readdirSync(probe);

    expect(() => repo.load('')).toThrow(WorkflowError);
    expect(() => repo.load('   ')).toThrow(/non-empty workspace root/);
    expect(readdirSync(probe)).toEqual(before);
    expect(existsSync(path.join(probe, '.sdlc', 'daemon'))).toBe(false);
  });

  it('rejects a missing contract file', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'daemon-cfg-missing-'));
    expect(() => repo.load(root)).toThrow(/Daemon config not found/);
  });

  it('rejects malformed JSON and missing required fields', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'daemon-cfg-bad-'));
    mkdirSync(path.join(root, '.sdlc'), { recursive: true });
    writeFileSync(path.join(root, '.sdlc', 'daemon.json'), '{', 'utf-8');
    expect(() => repo.load(root)).toThrow(/Malformed daemon config/);

    writeDaemonConfig(root, { defaultPollSeconds: 0 });
    expect(() => repo.load(root)).toThrow(/positive number defaultPollSeconds/);

    writeDaemonConfig(root, { activateScript: '' });
    expect(() => repo.load(root)).toThrow(/activateScript/);
  });

  it('keeps absolute contract paths absolute', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'daemon-cfg-abs-'));
    const absRuns = path.join(root, 'absolute-runs');
    writeDaemonConfig(root, { runsDir: absRuns });
    const { config } = repo.load(root);
    expect(config.runsDir).toBe(path.normalize(absRuns));
  });

  it('rejects a missing path and a non-directory root', () => {
    const missing = path.join(
      os.tmpdir(),
      `daemon-cfg-noent-${Date.now()}-${Math.random()}`
    );
    expect(() => repo.load(missing)).toThrow(/does not exist/);

    const fileRoot = path.join(
      mkdtempSync(path.join(os.tmpdir(), 'daemon-cfg-file-')),
      'not-a-dir'
    );
    writeFileSync(fileRoot, 'x', 'utf-8');
    expect(() => repo.load(fileRoot)).toThrow(/not a directory/);
  });

  it('loads optional operator when present and rejects an empty one', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'daemon-cfg-op-'));
    writeDaemonConfig(root, { operator: 'Roustalski' });
    expect(repo.load(root).config.operator).toBe('Roustalski');

    writeDaemonConfig(root, { operator: '   ' });
    expect(() => repo.load(root)).toThrow(WorkflowError);
  });

  it('derivePaths works without a daemon.json contract', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'daemon-cfg-derive-'));
    const paths = repo.derivePaths(root);
    expect(paths.launchdLabel).toMatch(
      /^sdlc\.workflow\.daemon\.[a-f0-9]{16}$/
    );
    expect(paths.logPath).toBe(
      path.join(root, '.sdlc', 'daemon', 'daemon.log')
    );
    // Still works when the workspace directory itself is gone.
    const gone = path.join(
      os.tmpdir(),
      `daemon-cfg-gone-${Date.now()}-${Math.random()}`
    );
    const gonePaths = repo.derivePaths(gone);
    expect(gonePaths.launchdLabel).toMatch(
      /^sdlc\.workflow\.daemon\.[a-f0-9]{16}$/
    );
    expect(() => repo.derivePaths('')).toThrow(/non-empty workspace root/);
  });
});

/**
 * Acceptance criterion: the daemon configuration loader source must not
 * embed organization, repository, path, or domain-specific literals.
 */
describe('DaemonConfigRepository source lint', () => {
  const sourcePath = path.resolve(
    __dirname,
    '..',
    'repositories',
    'daemon-config.repository.ts'
  );
  const source = readFileSync(sourcePath, 'utf-8');

  const forbidden = [
    'Rosetta-Foundation',
    'github.com',
    'bakerstreet',
    'HIPAA',
    'PHI',
    '/Users/',
    '/home/',
    '~/.rosetta',
    '.rosetta/sdlc',
    'com.rosetta'
  ];

  it('contains none of the forbidden hardcoded literals', () => {
    for (const term of forbidden) {
      expect(source).not.toContain(term);
    }
  });
});
