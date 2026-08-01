const regexCache = new Map<string, RegExp>();

const globToRegex = (glob: string): RegExp => {
  const cached = regexCache.get(glob);
  if (cached !== undefined) return cached;

  // Escape regex specials, then translate: '**' spans path separators,
  // '*' stays within one segment.
  const pattern = glob
    .split('**')
    .map(piece =>
      piece
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '[^/]*')
        .replace(/\?/g, '[^/]')
    )
    .join('.*');

  const regex = new RegExp(`^${pattern}$`);
  regexCache.set(glob, regex);
  return regex;
};

/** Match a repo-relative path against a glob like `sdlc-workflow/**`. */
export const matchesGlob = (glob: string, filePath: string): boolean =>
  globToRegex(glob).test(filePath);

/** True when the path matches at least one glob. */
export const matchesAnyGlob = (globs: string[], filePath: string): boolean =>
  globs.some(glob => matchesGlob(glob, filePath));
