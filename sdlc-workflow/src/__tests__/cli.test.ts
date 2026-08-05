import { execSync } from 'child_process';
import path from 'path';

const CWD = path.resolve(__dirname, '..', '..');

/**
 * Run the CLI and return combined output plus exit status. Argument parsing is
 * the only thing under test here, so a deliberately missing spec is fine — the
 * command getting far enough to complain about it proves yargs let it through.
 */
const cli = (args: string): { output: string; code: number } => {
  try {
    return {
      output: execSync(`bun run dev -- ${args} 2>&1`, {
        cwd: CWD,
        encoding: 'utf-8'
      }),
      code: 0
    };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return {
      output: `${e.stdout ?? ''}${e.stderr ?? ''}`,
      code: e.status ?? 1
    };
  }
};

describe('CLI (T-01)', () => {
  it('--help exits 0 and lists the decompose command', () => {
    const output = execSync('bun run dev -- --help', {
      cwd: CWD,
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
  });

  // `run` shipped completely unusable: `--enforce` was declared with
  // `default: false` and `.conflicts('shadow')`, and yargs counts a defaulted
  // option as supplied — so every invocation died on the conflict, including
  // one passing neither flag. `--help` still rendered fine, which is exactly
  // why the old help-only test missed it. These drive real argv.
  describe('run argument parsing', () => {
    const missingSpec = '--spec /tmp/sdlc-cli-test-missing.md --repo /tmp';

    it.each([
      ['neither flag (enforcing is the default)', ''],
      ['--shadow alone', '--shadow'],
      ['--enforce alone', '--enforce']
    ])('accepts %s', (_label, flags) => {
      const { output } = cli(`run ${missingSpec} ${flags}`.trim());

      expect(output).not.toContain('mutually exclusive');
      // Reached the handler, so parsing succeeded. Shadow reads the local
      // file; enforce fetches origin first (so a non-repo --repo fails at
      // git rather than "Spec file not found").
      if (flags.includes('--shadow')) {
        expect(output).toContain('Spec file not found');
      } else {
        expect(output).toMatch(
          /GIT_FAILED|Spec file not found|Refused at intake/
        );
      }
    });

    it('still rejects --shadow and --enforce together', () => {
      const { output, code } = cli(`run ${missingSpec} --shadow --enforce`);

      expect(output).toContain('mutually exclusive');
      expect(code).not.toBe(0);
    });
  });
});
