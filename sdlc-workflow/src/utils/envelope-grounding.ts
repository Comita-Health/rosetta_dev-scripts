import { SpecTask } from '../types';
import { matchesAnyGlob, matchesGlob } from './glob-match';

/**
 * Path-shaped tokens: at least two `/`-separated segments of file-name
 * characters (globs like `src/**` qualify). Kept deliberately narrow so
 * prose ("and/or", "either/or") does not read as a path — see the filters
 * in {@link extractPathRefs}.
 */
const PATH_TOKEN = /[A-Za-z0-9_@*][A-Za-z0-9_@.*-]*(?:\/[A-Za-z0-9_@.*-]+)+/g;

/**
 * Extract repo-path references from free text (task engineering notes).
 * A candidate token counts as a path when it is backtick-quoted, its last
 * segment looks like a file name (contains a dot), or it is at least three
 * segments deep. Tokens preceded by `/` are skipped so URL hosts
 * (`https://example.com/...`) are not misread as repo paths.
 */
export const extractPathRefs = (text: string): string[] => {
  const backticked = new Set<string>();
  for (const match of text.matchAll(/`([^`]+)`/g)) {
    backticked.add(match[1]);
  }

  const refs = new Set<string>();
  for (const match of text.matchAll(PATH_TOKEN)) {
    const index = match.index ?? 0;
    if (index > 0 && text[index - 1] === '/') continue;
    const token = match[0].replace(/[.,;:]+$/, '');
    const segments = token.split('/');
    const lastSegment = segments[segments.length - 1];
    const looksLikeFile = lastSegment.includes('.');
    const isDeep = segments.length > 2;
    if (backticked.has(token) || looksLikeFile || isDeep) {
      refs.add(token);
    }
  }
  return [...refs];
};

export interface EnvelopeGroundingResult {
  /** allowedPaths globs matching nothing in the tree and carrying no new-path justification. */
  ungroundedGlobs: string[];
  /** Diff-forecast warnings: task-note paths that fall outside the envelope. */
  warnings: string[];
}

/** Every ancestor directory of every listed file, so bare-directory globs ground. */
const directoriesOf = (repoFiles: string[]): Set<string> => {
  const dirs = new Set<string>();
  for (const file of repoFiles) {
    const segments = file.split('/');
    for (let i = 1; i < segments.length; i++) {
      dirs.add(segments.slice(0, i).join('/'));
    }
  }
  return dirs;
};

/**
 * Ground a synthesized envelope in the target repo tree (#35).
 *
 * A glob is grounded when it matches at least one existing file (or
 * directory) in `repoFiles`. A glob matching nothing is still acceptable
 * when a task explicitly names a new path under it in its engineering
 * notes — the new-path intent (e.g. "creates `src/services/foo.service.ts`").
 * Everything else is ungrounded and must fail synthesis.
 *
 * Separately, the diff-forecast heuristic: any path a task's engineering
 * notes reference that no allowedPaths glob covers yields a warning, so the
 * human reviews a coherent envelope instead of hitting a mid-run breach.
 */
export const groundAllowedPaths = (
  allowedPaths: string[],
  tasks: SpecTask[],
  repoFiles: string[]
): EnvelopeGroundingResult => {
  const taskRefs = tasks.map(task => ({
    taskId: task.id,
    refs: extractPathRefs(task.engineeringNotes)
  }));
  const allRefs = taskRefs.flatMap(entry => entry.refs);
  const dirs = directoriesOf(repoFiles);

  const ungroundedGlobs: string[] = [];
  for (const glob of allowedPaths) {
    const matchesTree =
      repoFiles.some(file => matchesGlob(glob, file)) ||
      [...dirs].some(dir => matchesGlob(glob, dir));
    if (matchesTree) continue;
    const justified = allRefs.some(ref => matchesGlob(glob, ref));
    if (!justified) {
      ungroundedGlobs.push(glob);
    }
  }

  const warnings: string[] = [];
  for (const entry of taskRefs) {
    for (const ref of entry.refs) {
      if (!matchesAnyGlob(allowedPaths, ref)) {
        warnings.push(
          `Task ${entry.taskId}: engineering notes reference "${ref}" ` +
            `outside the envelope's allowedPaths — likely mid-run breach`
        );
      }
    }
  }

  return { ungroundedGlobs, warnings };
};
