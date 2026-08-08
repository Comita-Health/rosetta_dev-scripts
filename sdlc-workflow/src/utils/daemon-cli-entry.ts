import { existsSync } from 'fs';
import path from 'path';
import { WorkflowError } from '../types';

export interface ResolveDaemonCliEntryOptions {
  /**
   * When true (default), a TypeScript entry requires `dist/index.js` to exist
   * so a KeepAlive load cannot point at a missing file. `--no-load` installs
   * set this false so plist dry-runs work before `bun run build`.
   */
  requireDist?: boolean;
}

/**
 * Resolve the absolute CLI path that launchd should exec for
 * `daemon install`.
 *
 * @remarks
 * Dev runners (`bun run dev` / `tsx`) set `__filename` to `src/index.ts`.
 * Plain `node` cannot load that tree (extensionless relative imports), so the
 * KeepAlive agent must point at the compiled `dist/index.js`. When the
 * installer is already the compiled entry, the path is returned unchanged.
 * Missing `dist/index.js` fails loud when `requireDist` is true — operators
 * must `bun run build` before a loaded install from a TypeScript entry.
 */
export const resolveDaemonCliEntry = (
  cliEntry: string,
  options: ResolveDaemonCliEntryOptions = {}
): string => {
  const requireDist = options.requireDist !== false;
  const absolute = path.resolve(cliEntry);
  const ext = path.extname(absolute).toLowerCase();
  if (ext === '.js' || ext === '.cjs' || ext === '.mjs') {
    return absolute;
  }
  if (ext !== '.ts' && ext !== '.cts' && ext !== '.mts') {
    return absolute;
  }

  const srcDir = path.dirname(absolute);
  const packageRoot =
    path.basename(srcDir) === 'src' ? path.dirname(srcDir) : srcDir;
  const distEntry = path.join(packageRoot, 'dist', 'index.js');
  if (existsSync(distEntry) === false && requireDist === true) {
    throw new WorkflowError(
      'daemon install from a TypeScript entry requires a compiled CLI',
      'DAEMON_CLI_ENTRY_MISSING',
      [
        `expected: ${distEntry}`,
        'run: bun run build (in sdlc-workflow), then retry install'
      ]
    );
  }
  return distEntry;
};
