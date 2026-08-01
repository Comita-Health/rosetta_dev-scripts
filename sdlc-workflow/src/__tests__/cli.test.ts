import { execSync } from 'child_process';
import path from 'path';

describe('CLI (T-01)', () => {
  it('--help exits 0 and lists the decompose command', () => {
    const output = execSync('bun run dev -- --help', {
      cwd: path.resolve(__dirname, '..', '..'),
      encoding: 'utf-8'
    });
    expect(output).toContain('decompose');
    expect(output).toContain('human gate');
  });
});
