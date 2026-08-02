/**
 * Rebuild `process.argv` for a detached supervise child: drop `--detach`,
 * ensure `--supervise` is present after the `run` subcommand.
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

  // Force foreground child (parent already detached).
  if (!filtered.includes('--no-detach')) {
    // yargs boolean: absence of --detach is enough; avoid unknown flags.
  }

  return filtered;
};
