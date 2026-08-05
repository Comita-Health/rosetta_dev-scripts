export interface QueuedRunArgvInput {
  /** The running process's entrypoint (`process.argv[1]`) at `queue-run` time. */
  scriptEntry: string;
  specPath: string;
  repoPath: string;
  runsDir: string;
  runId?: string;
  chronicleRepo?: string;
  maxParallel?: number;
  heartbeatSeconds?: number;
  maxWaves?: number;
  monitorPath?: string;
  operator?: string;
}

/**
 * Build the `run --supervise --detach` argv this queued record replays at
 * launch time — shaped like `process.argv` (`['node', <entry>, 'run', ...]`)
 * so {@link import('./supervise-argv').buildSuperviseChildArgv} can consume
 * it directly, the same as any other supervise child.
 */
export const buildQueuedRunArgv = (input: QueuedRunArgvInput): string[] => {
  const args = [
    'node',
    input.scriptEntry,
    'run',
    '--spec',
    input.specPath,
    '--repo',
    input.repoPath,
    '--runs-dir',
    input.runsDir
  ];
  if (input.runId !== undefined) {
    args.push('--run-id', input.runId);
  }
  if (input.chronicleRepo !== undefined) {
    args.push('--chronicle-repo', input.chronicleRepo);
  }
  if (input.maxParallel !== undefined) {
    args.push('--max-parallel', String(input.maxParallel));
  }
  if (input.heartbeatSeconds !== undefined) {
    args.push('--heartbeat', String(input.heartbeatSeconds));
  }
  if (input.maxWaves !== undefined) {
    args.push('--max-waves', String(input.maxWaves));
  }
  if (input.monitorPath !== undefined) {
    args.push('--monitor', input.monitorPath);
  }
  if (input.operator !== undefined) {
    args.push('--operator', input.operator);
  }
  args.push('--supervise', '--detach');
  return args;
};
