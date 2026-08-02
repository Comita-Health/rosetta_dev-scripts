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
