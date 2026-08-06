import { execSync } from 'child_process';
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
    // SPEC-PRD-0020-P1: daemon entrypoint is part of the public CLI surface.
    expect(output).toContain('daemon');
  });

  describe('run argument parsing', () => {
    const missingSpec = '--spec /tmp/sdlc-cli-test-missing.md --repo /tmp';

    it('accepts neither flag (enforcing is the default)', () => {
      const { output } = cli(`run ${missingSpec}`);

      expect(output).not.toContain('Unknown argument');
      expect(output).toMatch(
        /GIT_FAILED|Spec file not found|Refused at intake/
      );
    });

    it('accepts --shadow alone', () => {
      const { output } = cli(`run ${missingSpec} --shadow`);

      expect(output).not.toContain('Unknown argument');
      // Shadow still validates the repo checkout before reading the local
      // spec, so a non-git --repo fails at git rather than "Spec file not found".
      expect(output).toMatch(
        /GIT_FAILED|Spec file not found|Refused at intake/
      );
    });
  });

  describe('daemon install argument parsing', () => {
    it('accepts --no-load and writes a KeepAlive plist with a unique label', () => {
      const workspace = mkdtempSync(path.join(os.tmpdir(), 'daemon-cli-ws-'));
      const plistDir = mkdtempSync(path.join(os.tmpdir(), 'daemon-cli-plist-'));
      mkdirSync(path.join(workspace, '.sdlc'), { recursive: true });
      writeFileSync(
        path.join(workspace, '.sdlc', 'daemon.json'),
        JSON.stringify({
          activateScript: 'scripts/activate.sh',
          runsDir: 'var/runs',
          defaultPollSeconds: 30,
          headlessRunner: 'test-runner'
        }),
        'utf-8'
      );

      const { output, code } = cli(
        `daemon install --workspace ${workspace} --plist-dir ${plistDir} --no-load`
      );

      expect(output).not.toContain('Unknown argument');
      expect(code).toBe(0);
      expect(output).toMatch(/sdlc\.workflow\.daemon\.[a-f0-9]{16}/);
      expect(output).toContain('plist only');

      const plists = readdirSync(plistDir).filter(f => f.endsWith('.plist'));
      expect(plists).toHaveLength(1);
      const body = readFileSync(path.join(plistDir, plists[0]), 'utf-8');
      expect(body).toMatch(/<key>KeepAlive<\/key>\s*<true\/>/);
      expect(body).toMatch(
        /<key>Label<\/key>\s*<string>sdlc\.workflow\.daemon\.[a-f0-9]{16}<\/string>/
      );
      expect(body).toContain(`<string>${workspace}</string>`);

      const uninstall = cli(
        `daemon uninstall --workspace ${workspace} --plist-dir ${plistDir}`
      );
      expect(uninstall.code).toBe(0);
      expect(existsSync(path.join(plistDir, plists[0]))).toBe(false);
    });
  });
});
