import { execSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import chalk from 'chalk';
import { PersonalChronicleConfig } from '../types';

/**
 * Resolve the login of the currently authenticated `gh` user.
 * Returns null (with a log line) when gh is not authenticated.
 */
export const resolveGitHubUser = (): string | null => {
  try {
    const login = execSync('gh api user -q .login', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    return login.length > 0 ? login : null;
  } catch {
    console.log(chalk.yellow('  ⚠ Could not resolve gh user — is `gh auth login` complete?'));
    return null;
  }
};

/**
 * Derive the personal Chronicle repo name from a prefix and a gh login,
 * e.g. ('rosetta_chronicle', 'Example-User') -> 'rosetta_chronicle_example-user'.
 * The login is lowercased and its '/' characters (defensive) collapsed to '_'.
 */
export const derivePersonalRepoName = (namePrefix: string, login: string): string => {
  const slug = login.toLowerCase().replace(/\//g, '_');
  return `${namePrefix}_${slug}`;
};

/**
 * True when `gh` reports the org repo already exists. Any other failure
 * (auth, network) returns false so the caller attempts creation and surfaces
 * the real error.
 */
const repoExists = (org: string, repoName: string): boolean => {
  try {
    execSync(`gh repo view ${org}/${repoName}`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return true;
  } catch {
    return false;
  }
};

/**
 * Ensure the repo's default branch matches `defaultBranch`. `gh repo create`
 * names the initial branch after the *account's* configured default (often
 * `master`), so we normalize via GitHub's branch-rename API — which also
 * repoints the default branch. A no-op when it already matches. Best-effort:
 * a failure is logged, not fatal, since the repo itself was created fine.
 */
const normalizeDefaultBranch = (
  org: string,
  repoName: string,
  defaultBranch: string,
): void => {
  const fullName = `${org}/${repoName}`;
  try {
    const current = execSync(`gh api repos/${fullName} -q .default_branch`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();

    if (current === defaultBranch) return;

    execSync(
      `gh api -X POST repos/${fullName}/branches/${current}/rename -f new_name=${defaultBranch}`,
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
    );
    console.log(chalk.green(`  ✓ Default branch ${current} → ${defaultBranch}`));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(chalk.yellow(`  ⚠ Could not normalize default branch to ${defaultBranch}`));
    console.log(chalk.yellow(`    ${message.split('\n')[0]}`));
  }
};

/**
 * Run `yarn build` in the Chronicle engine repo so dist/bin/cli.js exists
 * when the Stop hook fires for the first time. Best-effort: failure is logged
 * but does not abort setup — the engineer can run `yarn build` manually.
 */
export const buildChronicleEngine = (engineDir: string): void => {
  const distCli = path.join(engineDir, 'dist', 'bin', 'cli.js');
  if (existsSync(distCli)) return;

  console.log(chalk.blue('  ↓ Building Chronicle CLI...'));
  try {
    execSync('yarn build', {
      cwd: engineDir,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    console.log(chalk.green('  ✓ Chronicle CLI built'));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(chalk.yellow(`  ⚠ Chronicle CLI build failed — run 'yarn build' in ${engineDir}`));
    console.log(chalk.yellow(`    ${message.split('\n')[0]}`));
  }
};

/**
 * Write baseline files into a freshly-cloned personal Chronicle repo.
 * Idempotent — skips any file that already exists.
 * Commits and pushes the seeded files so the repo stays clean for the engineer.
 */
export const seedPersonalRepoFiles = (repoPath: string): void => {
  const gitignorePath = path.join(repoPath, '.gitignore');
  if (existsSync(gitignorePath)) return;

  writeFileSync(gitignorePath, 'stop-hook.log\n');

  try {
    execSync('git add .gitignore', { cwd: repoPath, stdio: ['pipe', 'pipe', 'pipe'] });
    execSync('git commit -m "chore: ignore stop-hook.log"', {
      cwd: repoPath,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    execSync('git push', { cwd: repoPath, stdio: ['pipe', 'pipe', 'pipe'] });
    console.log(chalk.green('  ✓ Personal repo seeded (.gitignore)'));
  } catch {
    // Non-fatal: the file is written; git operations may fail if there's no
    // remote yet or the working tree is in an unexpected state.
  }
};

/**
 * Patch ~/.claude/settings.json to:
 *   1. Set CHRONICLE_REPO in the "env" block.
 *   2. Register hooks/stop-append.sh as an async Stop hook.
 *
 * Idempotent — re-running updates the paths without duplicating the hook entry.
 * Best-effort: if the file cannot be read/written, a warning is logged and
 * setup continues without the hook.
 */
export const installChronicleHook = (
  chronicleRepoPath: string,
  hookScriptPath: string,
  projectsDir: string,
): void => {
  console.log(chalk.bold('\nInstalling Chronicle Stop hook...'));

  const settingsPath = path.join(process.env.HOME ?? '~', '.claude', 'settings.json');

  let settings: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    } catch {
      console.log(chalk.yellow('  ⚠ Could not parse ~/.claude/settings.json — skipping hook install'));
      return;
    }
  }

  // Inject CHRONICLE_REPO and CHRONICLE_PROJECT into the env block.
  // CHRONICLE_PROJECT is set to the workspace root so sessions across all
  // repos under it are captured — not just the repo where a session happens to end.
  const env = (settings['env'] ?? {}) as Record<string, string>;
  env['CHRONICLE_REPO'] = chronicleRepoPath;
  env['CHRONICLE_PROJECT'] = projectsDir;
  settings['env'] = env;

  // Inject the Stop hook, replacing any existing chronicle entry by matching
  // on the hook script path so re-runs update rather than duplicate.
  const hooks = (settings['hooks'] ?? {}) as Record<string, unknown[]>;
  const stopHooks: Array<{ hooks: Array<{ type: string; command: string; async?: boolean }> }> =
    (hooks['Stop'] ?? []) as typeof stopHooks;

  // Remove any existing chronicle stop hook entry (identified by our script path).
  const filtered = stopHooks.filter(
    (entry) => !entry.hooks?.some((h) => h.command === hookScriptPath),
  );
  filtered.push({
    hooks: [{ type: 'command', command: hookScriptPath, async: true }],
  });
  hooks['Stop'] = filtered;
  settings['hooks'] = hooks;

  try {
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
    console.log(chalk.green(`  ✓ CHRONICLE_REPO set to ${chronicleRepoPath}`));
    console.log(chalk.green(`  ✓ CHRONICLE_PROJECT set to ${projectsDir}`));
    console.log(chalk.green(`  ✓ Stop hook registered in ~/.claude/settings.json`));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(chalk.yellow(`  ⚠ Could not write ~/.claude/settings.json: ${message}`));
  }

  // Build the CLI so the hook script can find dist/bin/cli.js immediately.
  buildChronicleEngine(path.dirname(path.dirname(hookScriptPath)));
};

/**
 * Create the engineer's private Chronicle repo under the org (if it does not
 * already exist) and clone it flat into baseDir. Idempotent: an existing repo
 * is swallowed with an explanatory log line rather than treated as an error.
 */
export const provisionPersonalChronicle = (
  config: PersonalChronicleConfig,
  baseDir: string,
  org: string,
): void => {
  console.log(chalk.bold('\nProvisioning personal Chronicle...'));

  const login = resolveGitHubUser();
  if (!login) {
    console.log(chalk.yellow('  ⚠ Skipping personal Chronicle — no authenticated gh user.'));
    return;
  }

  const repoName = derivePersonalRepoName(config.namePrefix, login);
  const targetDir = path.join(baseDir, repoName);
  const fullName = `${org}/${repoName}`;

  const hookScriptPath = path.join(baseDir, 'rosetta_chronicle', 'hooks', 'stop-append.sh');

  // Already cloned locally — still re-install the hook in case paths changed.
  if (existsSync(path.join(targetDir, '.git'))) {
    console.log(chalk.gray(`  ⊘ ${repoName} (already cloned)`));
    installChronicleHook(targetDir, hookScriptPath, baseDir);
    return;
  }

  if (repoExists(org, repoName)) {
    console.log(chalk.gray(`  ⊘ ${fullName} (already exists) — cloning existing repo`));
  } else {
    try {
      console.log(chalk.blue(`  ↓ Creating ${config.visibility} repo ${fullName}...`));
      // --add-readme seeds an initial commit so the repo has a real default
      // branch we can normalize (an empty repo cannot have its default set).
      execSync(
        `gh repo create ${fullName} --${config.visibility} --description "${config.description}" --add-readme`,
        { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
      );
      console.log(chalk.green(`  ✓ Created ${fullName}`));
      normalizeDefaultBranch(org, repoName, config.defaultBranch);
    } catch (err) {
      // Swallow the "already exists" race; surface anything else.
      const message = err instanceof Error ? err.message : String(err);
      if (/already exists|Name already exists/i.test(message)) {
        console.log(chalk.gray(`  ⊘ ${fullName} (already exists) — cloning existing repo`));
      } else {
        console.log(chalk.red(`  ✗ ${repoName}: could not create repo`));
        console.log(chalk.red(`    ${message.split('\n')[0]}`));
        return;
      }
    }
  }

  try {
    console.log(chalk.blue(`  ↓ Cloning ${fullName}...`));
    execSync(`gh repo clone ${fullName} "${targetDir}"`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    console.log(chalk.green(`  ✓ ${repoName}`));
  } catch (err) {
    console.log(chalk.red(`  ✗ ${repoName}: clone failed`));
    if (err instanceof Error) {
      console.log(chalk.red(`    ${err.message.split('\n')[0]}`));
    }
    return;
  }

  seedPersonalRepoFiles(targetDir);
  installChronicleHook(targetDir, hookScriptPath, baseDir);
};
