import {
  buildSuperviseChildArgv,
  resolveSuperviseLaunchArgv
} from '../utils/supervise-argv';

describe('resolveSuperviseLaunchArgv', () => {
  it('uses live argv when it already contains run', () => {
    const out = resolveSuperviseLaunchArgv({
      argv: ['node', 'src/index.ts', 'run', '--repo', '/r', '--supervise'],
      specPath: '/s',
      repoPath: '/r',
      runsDir: '/runs',
      runId: 'run-1'
    });
    expect(out).toContain('run');
    expect(out).toContain('--supervise');
    expect(out).not.toContain('--detach');
  });

  it('synthesizes argv when process.argv has no run subcommand', () => {
    const out = resolveSuperviseLaunchArgv({
      argv: ['node', 'jest'],
      scriptEntry: 'src/index.ts',
      specPath: '/spec.md',
      repoPath: '/repo',
      runsDir: '/runs',
      runId: 'run-1',
      chronicleRepo: '/chronicle',
      maxParallel: 2,
      heartbeatSeconds: 15,
      maxWaves: 8,
      monitorPath: '/mon.log',
      operator: 'alice'
    });
    expect(out).toEqual(
      expect.arrayContaining([
        'run',
        '--spec',
        '/spec.md',
        '--repo',
        '/repo',
        '--run-id',
        'run-1',
        '--chronicle-repo',
        '/chronicle',
        '--max-parallel',
        '2',
        '--heartbeat',
        '15',
        '--max-waves',
        '8',
        '--monitor',
        '/mon.log',
        '--operator',
        'alice',
        '--supervise'
      ])
    );
  });
});

describe('buildSuperviseChildArgv', () => {
  it('strips --detach and injects --supervise after run', () => {
    const out = buildSuperviseChildArgv([
      '/usr/bin/node',
      'src/index.ts',
      'run',
      '--spec',
      '/s.md',
      '--repo',
      '/r',
      '--detach'
    ]);
    expect(out).not.toContain('--detach');
    expect(out.indexOf('--supervise')).toBe(out.indexOf('run') + 1);
    expect(out).toContain('--spec');
  });

  it('does not duplicate --supervise', () => {
    const out = buildSuperviseChildArgv([
      'node',
      'src/index.ts',
      'run',
      '--supervise',
      '--detach'
    ]);
    expect(out.filter(a => a === '--supervise')).toHaveLength(1);
  });

  it('throws when run subcommand is missing', () => {
    expect(() => buildSuperviseChildArgv(['node', 'src/index.ts'])).toThrow(
      /no "run" subcommand/
    );
  });

  it('strips --detach=true style flags', () => {
    const out = buildSuperviseChildArgv([
      'node',
      'src/index.ts',
      'run',
      '--detach=true'
    ]);
    expect(out.some(a => a.startsWith('--detach'))).toBe(false);
    expect(out).toContain('--supervise');
  });

  it('wraps a bare .ts entrypoint with the tsx CLI for detached Node', () => {
    const out = buildSuperviseChildArgv([
      'node',
      'src/index.ts',
      'run',
      '--spec',
      '/s.md',
      '--detach'
    ]);
    expect(out[0]).toMatch(/tsx[/\\]dist[/\\]cli/);
    expect(out).toContain('src/index.ts');
    expect(out).toContain('--supervise');
  });

  it('treats --supervise=true as already present', () => {
    const out = buildSuperviseChildArgv([
      'node',
      'src/index.ts',
      'run',
      '--supervise=true',
      '--detach'
    ]);
    expect(
      out.filter(a => a === '--supervise' || a.startsWith('--supervise='))
    ).toHaveLength(1);
  });

  it('inserts tsx before a .ts entry that follows other argv tokens', () => {
    const out = buildSuperviseChildArgv([
      'node',
      '--no-warnings',
      'src/index.mts',
      'run',
      '--detach'
    ]);
    const tsIdx = out.indexOf('src/index.mts');
    expect(tsIdx).toBeGreaterThan(0);
    expect(out[tsIdx - 1]).toMatch(/tsx[/\\]dist[/\\]cli/);
  });

  it('does not wrap when tsx is already on the argv path', () => {
    const out = buildSuperviseChildArgv([
      'node',
      '/app/node_modules/tsx/dist/cli.mjs',
      'src/index.ts',
      'run',
      '--detach'
    ]);
    expect(out.filter(a => a.includes('tsx')).length).toBe(1);
    expect(out[0]).toContain('tsx');
  });
});
