import { execSync } from 'child_process';
import { existsSync, readdirSync } from 'fs';
import * as path from 'path';
import { WorkflowError } from '../types';

/** Activate scripts under ~/.config/<workspace>/, by workspace name. */
const configuredWorkspaces = (
  home: string
): Array<{ name: string; script: string }> => {
  const configRoot = path.join(home, '.config');
  if (!existsSync(configRoot)) {
    return [];
  }
  return readdirSync(configRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => ({
      name: entry.name,
      script: path.join(configRoot, entry.name, 'github-app-activate.sh')
    }))
    .filter(entry => existsSync(entry.script))
    .sort((left, right) => left.name.localeCompare(right.name));
};

/**
 * Resolve the workspace GitHub App activate script for mutating gh calls.
 *
 * @param owner - GitHub owner the write targets. A workspace's App is
 * installed on that workspace's org only, so writing to `Comita-Health` with
 * the `rosetta` App fails `Resource not accessible by integration` — a
 * permission error that reads like a missing grant but is the wrong App.
 * When `owner` is given, a workspace whose directory name prefixes it
 * (`comita` for `Comita-Health`) is preferred, longest match first.
 *
 * @remarks
 * Explicit env overrides still win, so a caller that knows better than the
 * name heuristic can say so. Without an `owner` the order is unchanged:
 * SDLC_GH_ACTIVATE -> ROSETTA_GH_ACTIVATE -> ~/.config/rosetta/... -> first
 * ~/.config/<workspace>/github-app-activate.sh.
 */
export const discoverActivateScript = (
  home = process.env.HOME ?? '',
  env: NodeJS.ProcessEnv = process.env,
  owner?: string
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

  const workspaces = configuredWorkspaces(home);

  if (owner !== undefined && owner.length > 0) {
    const target = owner.toLowerCase();
    const matched = workspaces
      .filter(entry => target.startsWith(entry.name.toLowerCase()))
      .sort((left, right) => right.name.length - left.name.length)[0];
    if (matched !== undefined) {
      return matched.script;
    }
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

  return workspaces.length > 0 ? workspaces[0].script : null;
};

/** True for Addi bot logins (addi-m[bot], app/addi-m, rosetta-s-addi-m[bot], ...). */
export const isAddiLogin = (login: string): boolean => /addi/i.test(login);

/**
 * GraphQL viewer login under env. Installation tokens often 403 on
 * GET /user, so this uses the same viewer query operators already use.
 */
export const viewerLogin = (env: NodeJS.ProcessEnv, cwd?: string): string => {
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
      'GitHub App token script missing next to activate script: ' + tokenScript,
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
 * GitHub App installation tokens are valid for 60 minutes. A supervised run
 * routinely outlives that several times over, so a token minted once at
 * launch and inherited by every later call goes 401 mid-run - and because
 * the deploy watch, the CI poll and the escalation post all use it, they
 * fail together and the run reads its own expired credential as a red gate.
 *
 * Re-minting is cheap relative to the TTL, so tokens are cached per activate
 * script and refreshed well before the boundary rather than at it - a call
 * that starts just under the wire must not straddle expiry while it runs.
 */
const TOKEN_TTL_MS = 45 * 60_000;

interface CachedToken {
  token: string;
  mintedAt: number;
}

const tokenCache = new Map<string, CachedToken>();

/** Drop cached tokens. Call after a 401 and on test teardown. */
export const resetAddiTokenCache = (): void => {
  tokenCache.clear();
};

/**
 * Cached installation token for an activate script, minting on first use and
 * whenever the cached one is older than {@link TOKEN_TTL_MS}.
 *
 * @remarks
 * `fresh` reports whether this call minted. A cached token was already
 * proven to be Addi when it was minted, so re-running the viewer query for
 * every gh command would double the API traffic to re-answer a settled
 * question - only a fresh mint needs verifying.
 */
const installationToken = (
  activateScript: string,
  now: number = Date.now()
): { token: string; fresh: boolean } => {
  const cached = tokenCache.get(activateScript);
  if (cached !== undefined && now - cached.mintedAt < TOKEN_TTL_MS) {
    return { token: cached.token, fresh: false };
  }
  const token = mintInstallationToken(activateScript);
  tokenCache.set(activateScript, { token, mintedAt: now });
  return { token, fresh: true };
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
 *
 * `options.owner` is the GitHub owner being written to. Being Addi is not
 * sufficient when several workspaces each have their own App: the ambient
 * session can be a *different* org's Addi, which authenticates fine and then
 * fails the write with `Resource not accessible by integration`. So when an
 * owner-specific activate script exists, its token is minted in preference to
 * reusing whatever Addi the ambient session happens to hold.
 */
export const envForAddiWrite = (
  baseEnv: NodeJS.ProcessEnv = process.env,
  options: { home?: string; cwd?: string; owner?: string } = {}
): NodeJS.ProcessEnv => {
  const home = options.home ?? baseEnv.HOME ?? process.env.HOME ?? '';
  const activate = discoverActivateScript(home, baseEnv, options.owner);
  const ownerScoped =
    options.owner !== undefined &&
    options.owner.length > 0 &&
    activate !== null &&
    discoverActivateScript(home, baseEnv) !== activate;

  if (ownerScoped === false) {
    try {
      const current = viewerLogin(baseEnv, options.cwd);
      if (isAddiLogin(current)) {
        return { ...baseEnv };
      }
    } catch {
      // Ambient session missing or unusable - try App activation below.
    }
  }

  if (activate === null) {
    throw new WorkflowError(
      'Refusing gh write as ambient human auth - no GitHub App activate script found (set SDLC_GH_ACTIVATE or install ~/.config/<workspace>/github-app-activate.sh)',
      'GH_NOT_ADDI',
      []
    );
  }

  let token: string;
  let fresh: boolean;
  try {
    ({ token, fresh } = installationToken(activate));
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

  if (fresh === false) {
    return env;
  }

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
