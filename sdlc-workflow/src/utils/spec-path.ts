import { matchesAnyGlob } from './glob-match';

/** Mid-run edits under specs/ are forbidden even when listed in allowedPaths. */
const SPEC_TREE_GLOBS = ['specs/**', '**/specs/**'] as const;

/**
 * True when a repo-relative path is under a `specs/` tree (ADR-0008 docs).
 *
 * @remarks
 * Two callers rely on this being one predicate rather than two similar
 * regexes: the envelope gate, which hard-breaches any agent diff touching a
 * spec, and the closeout write route, which is the single writer allowed
 * through that rule. If they ever disagree about what counts as a spec path,
 * one of them is wrong — so they share this.
 */
export const isSpecTreePath = (filePath: string): boolean =>
  matchesAnyGlob([...SPEC_TREE_GLOBS], filePath);
