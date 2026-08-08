import { createHash } from 'crypto';
import { existsSync, readFileSync, statSync } from 'fs';
import { injectable } from 'inversify';
import path from 'path';
import { DaemonConfig, DaemonRuntimePaths, WorkflowError } from '../types';

/**
 * Relative path of the consumer-owned daemon contract under a workspace root
 * (PRD-0020 §4). The file supplies activateScript / runsDir / poll / runner;
 * the loader never invents org, repo, or host-specific defaults.
 */
export const DAEMON_CONFIG_REL_PATH = path.join('.sdlc', 'daemon.json');

export interface DaemonResolvedConfig {
  config: DaemonConfig;
  paths: DaemonRuntimePaths;
}

/**
 * Loads {@link DaemonConfig} from files under a declared workspace root and
 * derives per-workspace runtime paths. The only required caller input is the
 * workspace root; every other value is discovered or derived from that root.
 */
export interface IDaemonConfigRepository {
  /**
   * Derive pid/log/launchd identity from the workspace root alone — no
   * `.sdlc/daemon.json` read. Used by uninstall so a missing or malformed
   * contract cannot block launchd unload / plist removal.
   *
   * @throws {WorkflowError} `DAEMON_CONFIG_INVALID` when the root is empty.
   */
  derivePaths(workspaceRoot: string): DaemonRuntimePaths;
  /**
   * Resolve and validate daemon configuration for `workspaceRoot`.
   *
   * @throws {WorkflowError} `DAEMON_CONFIG_INVALID` when the root is missing,
   *   empty, not a directory, or the contract file is absent/malformed.
   */
  load(workspaceRoot: string): DaemonResolvedConfig;
}

const requireString = (
  raw: Record<string, unknown>,
  key: string,
  file: string
): string => {
  const value = raw[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new WorkflowError(
      `Daemon config ${file} requires a non-empty string ${key}`,
      'DAEMON_CONFIG_INVALID'
    );
  }
  return value.trim();
};

const requirePositiveNumber = (
  raw: Record<string, unknown>,
  key: string,
  file: string
): number => {
  const value = raw[key];
  if (typeof value !== 'number' || Number.isNaN(value) || value <= 0) {
    throw new WorkflowError(
      `Daemon config ${file} requires a positive number ${key}`,
      'DAEMON_CONFIG_INVALID'
    );
  }
  return value;
};

/**
 * Resolve a path from the contract: absolute values stay absolute; relative
 * values are resolved against the workspace root.
 */
const resolveUnderRoot = (workspaceRoot: string, value: string): string =>
  path.isAbsolute(value)
    ? path.normalize(value)
    : path.resolve(workspaceRoot, value);

/**
 * Stable, workspace-unique launchd label fragment derived only from the
 * absolute workspace root (no org/repo hostname vocabulary).
 */
const workspaceId = (absoluteRoot: string): string =>
  createHash('sha256').update(absoluteRoot).digest('hex').slice(0, 16);

const requireNonEmptyRoot = (workspaceRoot: string): string => {
  if (typeof workspaceRoot !== 'string' || workspaceRoot.trim().length === 0) {
    throw new WorkflowError(
      'Daemon requires a non-empty workspace root path',
      'DAEMON_CONFIG_INVALID'
    );
  }
  return path.resolve(workspaceRoot.trim());
};

/**
 * Pid/log/launchd identity derived only from the absolute workspace root.
 * Shared by {@link DaemonConfigRepository.load} and uninstall recovery.
 */
export const deriveDaemonRuntimePaths = (
  absoluteRoot: string
): DaemonRuntimePaths => {
  const stateDir = path.join(absoluteRoot, '.sdlc', 'daemon');
  const id = workspaceId(absoluteRoot);
  return {
    stateDir,
    pidFile: path.join(stateDir, 'daemon.pid'),
    logPath: path.join(stateDir, 'daemon.log'),
    launchdLabel: `sdlc.workflow.daemon.${id}`
  };
};

@injectable()
export class DaemonConfigRepository implements IDaemonConfigRepository {
  derivePaths(workspaceRoot: string): DaemonRuntimePaths {
    return deriveDaemonRuntimePaths(requireNonEmptyRoot(workspaceRoot));
  }

  load(workspaceRoot: string): DaemonResolvedConfig {
    const absoluteRoot = requireNonEmptyRoot(workspaceRoot);
    if (!existsSync(absoluteRoot)) {
      throw new WorkflowError(
        `Workspace root does not exist: ${absoluteRoot}`,
        'DAEMON_CONFIG_INVALID'
      );
    }
    if (!statSync(absoluteRoot).isDirectory()) {
      throw new WorkflowError(
        `Workspace root is not a directory: ${absoluteRoot}`,
        'DAEMON_CONFIG_INVALID'
      );
    }

    const configFile = path.join(absoluteRoot, DAEMON_CONFIG_REL_PATH);
    if (!existsSync(configFile)) {
      throw new WorkflowError(
        `Daemon config not found: ${configFile}`,
        'DAEMON_CONFIG_INVALID'
      );
    }

    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(readFileSync(configFile, 'utf-8')) as Record<
        string,
        unknown
      >;
    } catch (err) {
      throw new WorkflowError(
        `Malformed daemon config JSON: ${configFile}`,
        'DAEMON_CONFIG_INVALID',
        [err instanceof Error ? err.message : String(err)]
      );
    }

    const activateScript = resolveUnderRoot(
      absoluteRoot,
      requireString(raw, 'activateScript', configFile)
    );
    const runsDir = resolveUnderRoot(
      absoluteRoot,
      requireString(raw, 'runsDir', configFile)
    );
    const defaultPollSeconds = requirePositiveNumber(
      raw,
      'defaultPollSeconds',
      configFile
    );
    const headlessRunner = requireString(raw, 'headlessRunner', configFile);
    const operatorRaw = raw.operator;
    let operator: string | undefined;
    if (operatorRaw !== undefined) {
      if (typeof operatorRaw !== 'string' || operatorRaw.trim().length === 0) {
        throw new WorkflowError(
          `Daemon config ${configFile} operator must be a non-empty string when set`,
          'DAEMON_CONFIG_INVALID'
        );
      }
      operator = operatorRaw.trim();
    }

    return {
      config: {
        workspaceRoot: absoluteRoot,
        activateScript,
        runsDir,
        defaultPollSeconds,
        headlessRunner,
        ...(operator === undefined ? {} : { operator })
      },
      paths: deriveDaemonRuntimePaths(absoluteRoot)
    };
  }
}
