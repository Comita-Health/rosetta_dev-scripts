import { readdirSync, readFileSync } from 'fs';
import path from 'path';
import { lintSpec } from '../utils/spec-lint';

const SPECS_ROOT = path.join(__dirname, '..', '..', '..', 'specs');

const listSpecFiles = (dir: string): string[] => {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listSpecFiles(full));
    } else if (entry.name.endsWith('.md')) {
      out.push(full);
    }
  }
  return out;
};

const specFiles = listSpecFiles(SPECS_ROOT);

/** A well-formed inline-array spec used as the reshape baseline. */
const CLEAN_SPEC = [
  '---',
  'id: SPEC-X-P1',
  'prd: PRD-X',
  'phase: 1',
  'status: Approved',
  'envelope:',
  "  allowedPaths: ['src/**', 'README.md']",
  '  forbiddenSurfaces: []',
  '  maxDiffLines: 800',
  '  budgetK: 200',
  '---',
  '',
  '# SPEC-X-P1: Clean.',
  '',
  '## Task T-01: Do it',
  '',
  '- **Complexity:** S',
  '',
  '### Acceptance criteria',
  '',
  '- [ ] test: it works',
  '- [ ] docs: it is documented'
].join('\n');

describe('lintSpec', () => {
  it('accepts every spec currently under specs/** on this repo', () => {
    expect(specFiles.length).toBeGreaterThan(0);
    const rejected = specFiles
      .map(file => ({ file, report: lintSpec(readFileSync(file, 'utf-8')) }))
      .filter(({ report }) => !report.ok);

    // Surface the exact offenders if this ever regresses.
    expect(
      rejected.map(
        ({ file, report }) =>
          `${path.relative(SPECS_ROOT, file)}: ` +
          report.findings.map(f => `${f.code} ${f.message}`).join('; ')
      )
    ).toEqual([]);
  });

  it('accepts the clean baseline spec, recognizing the docs tier', () => {
    const report = lintSpec(CLEAN_SPEC);
    expect(report.ok).toBe(true);
    expect(report.specId).toBe('SPEC-X-P1');
    expect(report.taskCount).toBe(1);
    expect(report.criterionCount).toBe(2);
  });

  it('rejects a Prettier-reshaped envelope (flow array folded to a block sequence) with a named error', () => {
    // `prettier`/hand-edit reshaping the inline flow array into a YAML block
    // sequence is silently mis-joined by the tolerant parser into one garbage
    // glob — the envelope stops guarding anything. spec-lint is the guard that
    // names it before intake does (the Prettier incident, #40 / ADR-0008).
    const reshaped = CLEAN_SPEC.replace(
      "  allowedPaths: ['src/**', 'README.md']",
      ['  allowedPaths:', "    - 'src/**'", "    - 'README.md'"].join('\n')
    );

    const report = lintSpec(reshaped);

    expect(report.ok).toBe(false);
    const malformed = report.findings.filter(f => f.code === 'SPEC_MALFORMED');
    expect(malformed.length).toBeGreaterThan(0);
    expect(malformed[0].message).toMatch(/allowedPaths/);
    expect(malformed[0].message).toMatch(/reshaped by a formatter/);
  });

  it('names a missing envelope field via the front-matter parse layer', () => {
    const broken = CLEAN_SPEC.replace('  maxDiffLines: 800\n', '');
    const report = lintSpec(broken);
    expect(report.ok).toBe(false);
    expect(report.findings[0].code).toBe('SPEC_MALFORMED');
    expect(report.findings[0].message).toMatch(/maxDiffLines/);
  });

  it('rejects a criterion missing a recognized verification-tier tag', () => {
    const untagged = CLEAN_SPEC.replace(
      '- [ ] test: it works',
      '- [ ] it works but is untagged'
    );
    const report = lintSpec(untagged);
    expect(report.ok).toBe(false);
    const finding = report.findings.find(f =>
      /verification-tier/.test(f.message)
    );
    expect(finding).toBeDefined();
    expect(finding?.code).toBe('SPEC_MALFORMED');
  });

  it('rejects an empty allowedPaths envelope', () => {
    const empty = CLEAN_SPEC.replace(
      "  allowedPaths: ['src/**', 'README.md']",
      '  allowedPaths: []'
    );
    const report = lintSpec(empty);
    expect(report.ok).toBe(false);
    expect(
      report.findings.some(
        f => f.code === 'SPEC_INVALID' && /allowedPaths/.test(f.message)
      )
    ).toBe(true);
  });

  it('rejects non-positive maxDiffLines and budgetK', () => {
    const zeroed = CLEAN_SPEC.replace(
      '  maxDiffLines: 800',
      '  maxDiffLines: 0'
    ).replace('  budgetK: 200', '  budgetK: 0');
    const report = lintSpec(zeroed);
    expect(report.ok).toBe(false);
    expect(report.findings.some(f => /maxDiffLines/.test(f.message))).toBe(
      true
    );
    expect(report.findings.some(f => /budgetK/.test(f.message))).toBe(true);
  });

  it('flags a reshaped forbiddenSurfaces array too', () => {
    const reshaped = CLEAN_SPEC.replace(
      '  forbiddenSurfaces: []',
      ['  forbiddenSurfaces:', "    - 'ci-config'", "    - 'auth'"].join('\n')
    );
    const report = lintSpec(reshaped);
    expect(report.ok).toBe(false);
    expect(
      report.findings.some(
        f => f.code === 'SPEC_MALFORMED' && /forbiddenSurfaces/.test(f.message)
      )
    ).toBe(true);
  });

  it('reports a dependency on an unknown task', () => {
    const withDep = CLEAN_SPEC.replace(
      '- **Complexity:** S',
      '- **Complexity:** S\n- **Depends on:** [T-99]'
    );
    const report = lintSpec(withDep);
    expect(report.ok).toBe(false);
    expect(
      report.findings.some(
        f => f.code === 'SPEC_INVALID' && /unknown task "T-99"/.test(f.message)
      )
    ).toBe(true);
  });

  it('reports a task with no acceptance criteria', () => {
    const noCriteria = CLEAN_SPEC.replace(
      '- [ ] test: it works\n- [ ] docs: it is documented',
      'None yet.'
    );
    const report = lintSpec(noCriteria);
    expect(report.ok).toBe(false);
    expect(
      report.findings.some(
        f =>
          f.code === 'SPEC_INVALID' && /no acceptance criteria/.test(f.message)
      )
    ).toBe(true);
  });
});
