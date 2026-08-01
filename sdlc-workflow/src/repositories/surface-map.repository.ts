import { existsSync, readFileSync } from 'fs';
import { injectable } from 'inversify';
import path from 'path';

/**
 * Loads the repo-level protected-surface map: label → path globs, from
 * `<repo>/.sdlc/surfaces.json`. Data-driven so envelope labels like
 * `migrations` or `auth` are never hardcoded in gate logic
 * (SPEC-PRD-0011-P2 T-02). A missing map resolves every label to no
 * paths — the gate reports such labels as unresolvable.
 */
export interface ISurfaceMapRepository {
  load(repoPath: string): Record<string, string[]>;
}

@injectable()
export class SurfaceMapRepository implements ISurfaceMapRepository {
  load(repoPath: string): Record<string, string[]> {
    const file = path.join(repoPath, '.sdlc', 'surfaces.json');
    if (!existsSync(file)) return {};
    return JSON.parse(readFileSync(file, 'utf-8')) as Record<string, string[]>;
  }
}
