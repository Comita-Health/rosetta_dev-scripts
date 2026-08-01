import { matchesAnyGlob, matchesGlob } from '../utils/glob-match';

describe('matchesGlob', () => {
  it('matches ** across path separators', () => {
    expect(matchesGlob('sdlc-workflow/**', 'sdlc-workflow/src/a.ts')).toBe(
      true
    );
    expect(matchesGlob('sdlc-workflow/**', 'team-setup/src/a.ts')).toBe(false);
  });

  it('keeps * within one segment', () => {
    expect(matchesGlob('src/*.ts', 'src/a.ts')).toBe(true);
    expect(matchesGlob('src/*.ts', 'src/deep/a.ts')).toBe(false);
  });

  it('escapes regex specials in literals', () => {
    expect(matchesGlob('a+b/c.ts', 'a+b/c.ts')).toBe(true);
    expect(matchesGlob('a+b/c.ts', 'aab/cxts')).toBe(false);
  });

  it('matchesAnyGlob returns true when any glob matches', () => {
    expect(matchesAnyGlob(['x/**', 'y/**'], 'y/z.ts')).toBe(true);
    expect(matchesAnyGlob(['x/**'], 'y/z.ts')).toBe(false);
  });
});
