import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';

/**
 * Continuity / headless-resume launch record (`launch.json`).
 *
 * Same argv surface the bash continuity daemon and EngineResume action use to
 * relaunch `--supervise` without a chat session.
 */
export interface SuperviseLaunchRecord {
  runId: string;
  argv: string[];
  execArgv: string[];
  execPath: string;
  cwd: string;
  runsDir: string;
  repoPath: string;
  specPath: string;
  chronicleRepo?: string;
  writtenAt: string;
}

export const launchRecordPath = (runsDir: string, runId: string): string =>
  path.join(runsDir, runId, 'launch.json');

const flagValue = (argv: string[], name: string): string | undefined => {
  const eq = argv.find(arg => arg.startsWith(`${name}=`));
  if (eq !== undefined) {
    return eq.slice(name.length + 1);
  }
  const idx = argv.indexOf(name);
  if (idx >= 0 && idx + 1 < argv.length) {
    return argv[idx + 1];
  }
  return undefined;
};

/**
 * Persist a relaunch record for `runId`.
 *
 * @remarks Overwrites on every supervise/detach start so argv stays current.
 */
export const writeSuperviseLaunchRecord = (input: {
  runsDir: string;
  runId: string;
  argv: string[];
  execArgv?: string[];
  execPath?: string;
  cwd?: string;
  repoPath?: string;
  specPath?: string;
  chronicleRepo?: string;
}): SuperviseLaunchRecord => {
  const runDir = path.join(input.runsDir, input.runId);
  mkdirSync(runDir, { recursive: true });
  const argv = [...input.argv];
  const record: SuperviseLaunchRecord = {
    runId: input.runId,
    argv,
    execArgv: [...(input.execArgv ?? process.execArgv)],
    execPath: input.execPath ?? process.execPath,
    cwd: input.cwd ?? process.cwd(),
    runsDir: input.runsDir,
    repoPath:
      input.repoPath ??
      flagValue(argv, '--repo') ??
      flagValue(argv, '-r') ??
      '',
    specPath: input.specPath ?? flagValue(argv, '--spec') ?? '',
    writtenAt: new Date().toISOString()
  };
  const chronicle =
    input.chronicleRepo ?? flagValue(argv, '--chronicle-repo') ?? undefined;
  if (chronicle !== undefined && chronicle.length > 0) {
    record.chronicleRepo = chronicle;
  }
  writeFileSync(
    launchRecordPath(input.runsDir, input.runId),
    `${JSON.stringify(record, null, 2)}\n`,
    'utf-8'
  );
  return record;
};

export const readSuperviseLaunchRecord = (
  runsDir: string,
  runId: string
): SuperviseLaunchRecord | null => {
  const file = launchRecordPath(runsDir, runId);
  if (!existsSync(file)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(file, 'utf-8')) as SuperviseLaunchRecord;
  } catch {
    return null;
  }
};

/**
 * Walk parents of `start` for `.sdlc/daemon.json` (workspace root).
 */
export const findWorkspaceRootWithDaemonConfig = (
  start: string
): string | null => {
  let dir = path.resolve(start);
  for (;;) {
    if (existsSync(path.join(dir, '.sdlc', 'daemon.json'))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return null;
    }
    dir = parent;
  }
};

/** Parse `https://github.com/owner/repo/pull/123` → `{ repo, number }`. */
export const parseGitHubPrUrl = (
  url: string
): { repo: string; number: number } | null => {
  const match = /github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/i.exec(url.trim());
  if (match === null) {
    return null;
  }
  return { repo: match[1], number: Number.parseInt(match[2], 10) };
};

/** Parse `https://github.com/owner/repo/issues/123` → `{ repo, number }`. */
export const parseGitHubIssueUrl = (
  url: string
): { repo: string; number: number } | null => {
  const match = /github\.com\/([^/]+\/[^/]+)\/issues\/(\d+)/i.exec(url.trim());
  if (match === null) {
    return null;
  }
  return { repo: match[1], number: Number.parseInt(match[2], 10) };
};
