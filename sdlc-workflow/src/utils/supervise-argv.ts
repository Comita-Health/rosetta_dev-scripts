import { createRequire } from 'module';
import path from 'path';

const nodeRequire = createRequire(__filename);

const isTypeScriptEntrypoint = (arg: string | undefined): boolean => {
  if (arg === undefined) {
    return false;
  }
  const lower = arg.toLowerCase();
  return (
    lower.endsWith('.ts') ||
    lower.endsWith('.cts') ||
    lower.endsWith('.mts') ||
    lower.endsWith('.tsx')
  );
};

/**
 * Rebuild `process.argv` for a detached supervise child: drop `--detach`,
 * ensure `--supervise` is present after the `run` subcommand, and wrap a
 * bare `.ts` entrypoint with the `tsx` CLI (Node cannot load `.ts` directly).
 */
/**
 * Prefer live `process.argv` when it already contains `run`; otherwise
 * synthesize a process.argv-shaped vector from supervise fields (tests and
 * non-CLI entrypoints).
 */
export const resolveSuperviseLaunchArgv = (input: {
  argv?: readonly string[];
  scriptEntry?: string;
  specPath: string;
  repoPath: string;
  runsDir: string;
  runId: string;
  chronicleRepo?: string;
  maxParallel?: number;
  heartbeatSeconds?: number;
  maxWaves?: number;
  monitorPath?: string;
  operator?: string;
}): string[] => {
  const live = input.argv ?? process.argv;
  if (live.includes('run')) {
    return buildSuperviseChildArgv(live);
  }
  const synthesized = [
    'node',
    input.scriptEntry ?? live[1] ?? 'sdlc-workflow',
    'run',
    '--spec',
    input.specPath,
    '--repo',
    input.repoPath,
    '--runs-dir',
    input.runsDir,
    '--run-id',
    input.runId
  ];
  if (input.chronicleRepo !== undefined) {
    synthesized.push('--chronicle-repo', input.chronicleRepo);
  }
  if (input.maxParallel !== undefined) {
    synthesized.push('--max-parallel', String(input.maxParallel));
  }
  if (input.heartbeatSeconds !== undefined) {
    synthesized.push('--heartbeat', String(input.heartbeatSeconds));
  }
  if (input.maxWaves !== undefined) {
    synthesized.push('--max-waves', String(input.maxWaves));
  }
  if (input.monitorPath !== undefined) {
    synthesized.push('--monitor', input.monitorPath);
  }
  if (input.operator !== undefined) {
    synthesized.push('--operator', input.operator);
  }
  synthesized.push('--supervise');
  return buildSuperviseChildArgv(synthesized);
};

export const buildSuperviseChildArgv = (argv: readonly string[]): string[] => {
  // argv[0] is node; argv[1+] are script + CLI args (or tsx loader + script).
  const nodeArgs = argv.slice(1);
  const filtered = nodeArgs.filter(arg => {
    if (arg === '--detach') {
      return false;
    }
    if (arg.startsWith('--detach=')) {
      return false;
    }
    return true;
  });

  const runIdx = filtered.indexOf('run');
  if (runIdx < 0) {
    throw new Error('cannot detach: argv has no "run" subcommand');
  }

  const hasSupervise = filtered.some(
    (arg, i) =>
      arg === '--supervise' ||
      arg.startsWith('--supervise=') ||
      (arg === 'supervise' && i > runIdx)
  );

  if (!hasSupervise) {
    filtered.splice(runIdx + 1, 0, '--supervise');
  }

  // bunx/tsx may leave only `src/index.ts run …` in argv for the child path;
  // ensure Node gets the tsx CLI first.
  if (isTypeScriptEntrypoint(filtered[0])) {
    const tsxCli = nodeRequire.resolve('tsx/cli');
    filtered.unshift(tsxCli);
  } else if (
    // Some runners put loader flags before the .ts file
    !filtered.some(
      a => a.includes(`${path.sep}tsx${path.sep}`) || a.endsWith('tsx')
    ) &&
    filtered.some(isTypeScriptEntrypoint)
  ) {
    const tsEntry = filtered.findIndex(isTypeScriptEntrypoint);
    const tsxCli = nodeRequire.resolve('tsx/cli');
    filtered.splice(tsEntry, 0, tsxCli);
  }

  return filtered;
};
