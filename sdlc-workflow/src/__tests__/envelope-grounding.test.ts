import {
  extractPathRefs,
  groundAllowedPaths
} from '../utils/envelope-grounding';
import { makeTask } from './fixtures';

describe('extractPathRefs', () => {
  it('extracts backticked paths, file-like tokens, and deep paths', () => {
    const refs = extractPathRefs(
      'Creates `src/services/foo.service.ts`, updates docs/setup.md and ' +
        'the a/b/c tree.'
    );
    expect(refs).toEqual(
      expect.arrayContaining([
        'src/services/foo.service.ts',
        'docs/setup.md',
        'a/b/c'
      ])
    );
    expect(refs).toHaveLength(3);
  });

  it('ignores prose slashes and URL hosts', () => {
    const refs = extractPathRefs(
      'Use and/or either/or; see https://example.com/docs/page for details.'
    );
    expect(refs).toEqual([]);
  });

  it('strips trailing punctuation from a referenced path', () => {
    expect(extractPathRefs('Touches src/index.ts.')).toEqual(['src/index.ts']);
  });

  it('extracts glob-shaped references', () => {
    expect(extractPathRefs('Stay within `sdlc-workflow/src/**`.')).toEqual([
      'sdlc-workflow/src/**'
    ]);
  });
});

describe('groundAllowedPaths', () => {
  const repoFiles = [
    'src/index.ts',
    'src/services/api.service.ts',
    'README.md'
  ];

  it('grounds globs that match existing files or directories', () => {
    const result = groundAllowedPaths(
      ['src/**', 'README.md', 'src/services'],
      [makeTask()],
      repoFiles
    );
    expect(result.ungroundedGlobs).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('names globs matching nothing and carrying no new-path justification', () => {
    const result = groundAllowedPaths(
      ['src/**', 'imaginary/**', 'ghost/file.ts'],
      [makeTask()],
      repoFiles
    );
    expect(result.ungroundedGlobs).toEqual(['imaginary/**', 'ghost/file.ts']);
  });

  it('accepts a glob matching nothing when a task names a new path under it', () => {
    const task = makeTask({
      engineeringNotes: 'Creates `lib/foo.service.ts` for the new adapter.'
    });
    const result = groundAllowedPaths(['src/**', 'lib/**'], [task], repoFiles);
    expect(result.ungroundedGlobs).toEqual([]);
  });

  it('warns per task for note paths the envelope does not cover', () => {
    const task = makeTask({
      id: 'T-02',
      engineeringNotes: 'Also touches docs/setup.md for the new flag.'
    });
    const result = groundAllowedPaths(['src/**'], [task], repoFiles);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('Task T-02');
    expect(result.warnings[0]).toContain('"docs/setup.md"');
    expect(result.warnings[0]).toContain('outside the envelope');
  });

  it('does not warn for note paths the envelope covers', () => {
    const task = makeTask({
      engineeringNotes: 'Extends `src/services/api.service.ts`.'
    });
    const result = groundAllowedPaths(['src/**'], [task], repoFiles);
    expect(result.warnings).toEqual([]);
  });
});
