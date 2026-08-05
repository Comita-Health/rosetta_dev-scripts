import { readdirSync, readFileSync } from 'fs';
import path from 'path';

/**
 * SPEC-PRD-0023-P1 T-06 — static pins for the specs/** single-writer policy.
 *
 * These assert facts about the source tree rather than runtime behaviour,
 * because the thing being protected is a policy: exactly one privileged writer
 * into `specs/**`, and a hard envelope breach for everyone else. Both are easy
 * to erode by an honest refactor, and neither erosion shows up as a behavioural
 * failure anywhere else in the suite.
 */
const ROOT = path.join(__dirname, '..');

const sourceFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return entry.name === '__tests__' ? [] : sourceFiles(full);
    }
    return entry.name.endsWith('.ts') ? [full] : [];
  });

describe('privileged spec-write route is single-caller (T-06)', () => {
  it('has exactly one caller of writeCloseout outside its own definition', () => {
    const callers = sourceFiles(ROOT).filter(file => {
      if (file.endsWith(path.join('repositories', 'spec-file.repository.ts'))) {
        return false;
      }
      return /\bwriteCloseout\s*\(/.test(readFileSync(file, 'utf-8'));
    });

    expect(callers.map(file => path.relative(ROOT, file))).toEqual([
      path.join('services', 'closeout.service.ts')
    ]);
  });

  it('routes every spec write through the repository, never fs directly', () => {
    // A service reaching for writeFileSync on a spec path would bypass both the
    // specs/**-only check and this caller pin.
    const offenders = sourceFiles(ROOT)
      .filter(
        file =>
          !file.endsWith(path.join('repositories', 'spec-file.repository.ts'))
      )
      .filter(file => {
        const source = readFileSync(file, 'utf-8');
        return /writeFileSync\([^)]*spec/i.test(source);
      });

    expect(offenders.map(file => path.relative(ROOT, file))).toEqual([]);
  });
});

describe('envelope-gate specs/** breach coverage is present and gating (T-06)', () => {
  const gateTest = readFileSync(
    path.join(__dirname, 'envelope-gate.service.test.ts'),
    'utf-8'
  );

  it('keeps the issue #40 self-ticking regression test present and unskipped', () => {
    const title =
      'breaches when a task diff edits its own spec file, even with allowedPaths covering it';

    expect(gateTest).toContain(`it('${title}'`);
    expect(gateTest).not.toContain(`it.skip('${title}'`);
    expect(gateTest).not.toContain(`xit('${title}'`);
  });

  it('leaves no skipped or focused tests in the envelope-gate suite', () => {
    // `it.only` would silently drop the sibling specs/** cases from the run
    // while still reporting a green suite.
    expect(gateTest).not.toMatch(/\b(it|describe)\.(skip|only)\(/);
    expect(gateTest).not.toMatch(/\b(xit|fit|xdescribe|fdescribe)\(/);
  });

  it('runs under the unfiltered suite that CI gates merges on', () => {
    const ci = readFileSync(
      path.join(ROOT, '..', '..', '.github', 'workflows', 'ci.yml'),
      'utf-8'
    );

    // The whole suite runs with no `-t` / path filter, so every test in it —
    // including the #40 breach test — blocks a merge on failure.
    expect(ci).toContain('cd sdlc-workflow && bun run test:coverage');
    expect(ci).not.toMatch(/bun run test:coverage\s+--?\S/);

    const scripts = JSON.parse(
      readFileSync(path.join(ROOT, '..', 'package.json'), 'utf-8')
    ).scripts;
    expect(scripts['test:coverage']).toBe('jest --coverage');
  });
});
