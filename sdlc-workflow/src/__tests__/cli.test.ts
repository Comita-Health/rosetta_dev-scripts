import { execSync } from 'child_process';
import path from 'path';

describe('CLI (T-01)', () => {
  it('--help exits 0 and lists the decompose command', () => {
    const output = execSync('bun run dev -- --help', {
      cwd: path.resolve(__dirname, '..', '..'),
      encoding: 'utf-8'
    });
    expect(output).toContain('decompose');
    expect(output).toContain('spec-lint');
    expect(output).toContain('human gate');
    expect(output).toContain('supervise');
    expect(output).toContain('detach');
    // SPEC-PRD-0023-P1: closeout is drivable by hand for interrupted jobs and
    // for specs that landed before the machinery existed.
    expect(output).toContain('closeout');
    expect(output).toContain('daemon');
  });
});
