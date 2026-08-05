import { buildQueuedRunArgv } from '../utils/queue-argv';

describe('buildQueuedRunArgv (T-02)', () => {
  it('builds a run --supervise --detach argv shaped like process.argv', () => {
    const argv = buildQueuedRunArgv({
      scriptEntry: 'src/index.ts',
      specPath: '/specs/a.md',
      repoPath: '/repo',
      runsDir: '/runs'
    });

    expect(argv).toEqual([
      'node',
      'src/index.ts',
      'run',
      '--spec',
      '/specs/a.md',
      '--repo',
      '/repo',
      '--runs-dir',
      '/runs',
      '--supervise',
      '--detach'
    ]);
  });

  it('includes every optional launch flag when provided', () => {
    const argv = buildQueuedRunArgv({
      scriptEntry: 'src/index.ts',
      specPath: '/specs/a.md',
      repoPath: '/repo',
      runsDir: '/runs',
      runId: 'run-42',
      chronicleRepo: '/chronicle',
      maxParallel: 2,
      heartbeatSeconds: 15,
      maxWaves: 5,
      monitorPath: '/tmp/monitor.log',
      operator: 'octocat'
    });

    expect(argv).toEqual([
      'node',
      'src/index.ts',
      'run',
      '--spec',
      '/specs/a.md',
      '--repo',
      '/repo',
      '--runs-dir',
      '/runs',
      '--run-id',
      'run-42',
      '--chronicle-repo',
      '/chronicle',
      '--max-parallel',
      '2',
      '--heartbeat',
      '15',
      '--max-waves',
      '5',
      '--monitor',
      '/tmp/monitor.log',
      '--operator',
      'octocat',
      '--supervise',
      '--detach'
    ]);
  });

  it('omits absent optional flags rather than emitting empty values', () => {
    const argv = buildQueuedRunArgv({
      scriptEntry: 'src/index.ts',
      specPath: '/specs/a.md',
      repoPath: '/repo',
      runsDir: '/runs'
    });

    expect(argv).not.toContain('--run-id');
    expect(argv).not.toContain('--chronicle-repo');
    expect(argv).not.toContain('--operator');
  });
});
