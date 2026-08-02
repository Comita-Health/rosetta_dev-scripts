import { buildSuperviseChildArgv } from '../utils/supervise-argv';

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
});
