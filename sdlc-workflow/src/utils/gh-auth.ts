import { execSync } from 'child_process';
import { existsSync, readdirSync } from 'fs';
import * as path from 'path';
import { WorkflowError } from '../types';

/**
 * Resolve the workspace GitHub App activate script for mutating gh calls.
 *
 * Order matches the watch scripts (pr-approve-watch, etc.):
 * SDLC_GH_ACTIVATE -> ROSETTA_GH_ACTIVATE -> ~/.config/rosetta/... ->
 * first ~/.config/<workspace>/github-app-activate.sh.
 */
export const discoverActivateScript = (
  home = process.env.HOME ?? '',
  env: NodeJS.ProcessEnv = process.env
): string | null => {
  for (const key of ['SDLC_GH_ACTIVATE', 'ROSETTA_GH_ACTIVATE'] as const) {
    const candidate = env[key];
    if (typeof candidate === 'string' && candidate.length > 0) {
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  }

  if (home.length === 0) {
    return null;
  }

  const rosetta = path.join(
    home,
    '.config',
    'rosetta',
    'github-app-activate.sh'
  );
  if (existsSync(rosetta)) {
    return rosetta;
  }

  const configRoot = path.join(home, '.config');
  if (!existsSync(configRoot)) {
    return null;
  }

  const matches = readdirSync(configRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry =>
      path.join(configRoot, entry.name, 'github-app-activate.sh')
    )
    .filter(candidate => existsSync(candidate))
    .sort();

  return matches.length > 0 ? matches[0] : null;
};

/** True for Addi bot logins (addi-m[bot], app/addi-m, rosetta-s-addi-m[bot], ...). */
export const isAddiLogin = (login: string): boolean => /addi/i.test(login);

/**
 * GraphQL viewer login under env. Installation tokens often 403 on
 * GET /user, so this uses the same viewer query operators already use.
 */
export const viewerLogin = (
  env: NodeJS.ProcessEnv,
  cwd?: string
): string => {
  const raw = execSync(
    "gh api graphql -f query='query { viewer { login } }' --jq '.data.viewer.login'",
    {
      cwd,
      env,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe']
    }
  );
  return raw.trim();
};

const mintInstallationToken = (activateScript: string): string => {
  const tokenScript = path.join(
    path.dirname(activateScript),
    'github-app-token.sh'
  );
  if (!existsSync(tokenScript)) {
    throw new WorkflowError(
      'GitHub App token script missing next to activate script: ' +
        tokenScript,
      'GH_NOT_ADDI',
      [activateScript]
    );
  }
  const token = execSync('bash "' + tokenScript + '"', {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe']
  }).trim();
  if (token.length === 0) {
    throw new WorkflowError(
      'GitHub App token script returned an empty token',
      'GH_NOT_ADDI',
      [tokenScript]
    );
  }
  return token;
};

/**
 * Environment for mutating gh writes (issue create, pr create, ...).
 *
 * @remarks
 * Escalation issues and SDLC PRs must be authored by the workspace GitHub App
 * (Addi) - never the ambient human gh login. Humans cannot Approve their
 * own PRs, and human-authored needs-human issues break the Addi -> watch
 * ownership loop. If the current env is already Addi, it is reused; otherwise
 * the activate/token scripts mint an installation token. Refusal to land on
 * Addi fails loud with WorkflowError code GH_NOT_ADDI rather than
 * falling through to the human.
 */
export const envForAddiWrite = (
  baseEnv: NodeJS.ProcessEnv = process.env,
  options: { home?: string; cwd?: string } = {}
): NodeJS.ProcessEnv => {
  const home = options.home ?? baseEnv.HOME ?? process.env.HOME ?? '';

  try {
    const current = viewerLogin(baseEnv, options.cwd);
    if (isAddiLogin(current)) {
      return { ...baseEnv };
    }
  } catch {
    // Ambient session missing or unusable - try App activation below.
  }

  const activate = discoverActivateScript(home, baseEnv);
  if (activate === null) {
    throw new WorkflowError(
      'Refusing gh write as ambient human auth - no GitHub App activate script found (set SDLC_GH_ACTIVATE or install ~/.config/<workspace>/github-app-activate.sh)',
      'GH_NOT_ADDI',
      []
    );
  }

  let token: string;
  try {
    token = mintInstallationToken(activate);
  } catch (err) {
    if (err instanceof WorkflowError) {
      throw err;
    }
    const detail = err instanceof Error ? err.message : String(err);
    throw new WorkflowError(
      'Failed to mint GitHub App installation token via ' + activate,
      'GH_NOT_ADDI',
      [detail.slice(0, 500)]
    );
  }

  const env: NodeJS.ProcessEnv = {
    ...baseEnv,
    GH_TOKEN: token,
    GITHUB_TOKEN: token
  };

  let login: string;
  try {
    login = viewerLogin(env, options.cwd);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new WorkflowError(
      'Minted GitHub App token but could not resolve viewer.login',
      'GH_NOT_ADDI',
      [detail.slice(0, 500)]
    );
  }

  if (!isAddiLogin(login)) {
    throw new WorkflowError(
      'Refusing gh write - viewer.login is "' +
        login +
        '", expected an Addi GitHub App identity',
      'GH_NOT_ADDI',
      [activate]
    );
  }

  return env;
};
