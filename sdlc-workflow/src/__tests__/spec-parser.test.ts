import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { SpecDocRepository } from '../repositories/spec-doc.repository';
import { renderSpec } from '../utils/spec-render';
import { parseSpec } from '../utils/spec-parser';
import { makeEnvelope, makeTask } from './fixtures';

const renderFixture = () =>
  renderSpec({
    specId: 'SPEC-PRD-0099-P1',
    prdId: 'PRD-0099',
    phase: 1,
    owner: 'Russ Watson',
    date: '2026-07-31',
    summary: 'A test spec.',
    context: 'Some context.',
    tasks: [
      makeTask(),
      makeTask({
        id: 'T-02',
        title: 'Extend the thing',
        dependsOn: ['T-01'],
        acceptanceCriteria: ['test: it extends', 'agent: it demos']
      })
    ],
    envelope: makeEnvelope()
  });

describe('parseSpec', () => {
  it('round-trips a rendered spec with no data loss', () => {
    const doc = parseSpec(renderFixture());

    expect(doc.id).toBe('SPEC-PRD-0099-P1');
    expect(doc.prdId).toBe('PRD-0099');
    expect(doc.phase).toBe(1);
    expect(doc.status).toBe('Draft');
    expect(doc.envelope).toEqual(makeEnvelope());
    expect(doc.tasks).toHaveLength(2);
    expect(doc.tasks[0]).toMatchObject({
      id: 'T-01',
      storyId: 'S-01',
      title: 'Build the thing',
      engineeringNotes: 'Keep it simple.',
      complexity: 'M',
      dependsOn: [],
      acceptanceCriteria: ['test: the thing builds']
    });
    expect(doc.tasks[1]).toMatchObject({
      id: 'T-02',
      dependsOn: ['T-01'],
      acceptanceCriteria: ['test: it extends', 'agent: it demos']
    });
  });

  it('parses an Approved status flip and checked criteria', () => {
    const markdown = renderFixture()
      .replace('status: Draft', 'status: Approved')
      .replace('- [ ] test: the thing builds', '- [x] test: the thing builds');
    const doc = parseSpec(markdown);
    expect(doc.status).toBe('Approved');
    expect(doc.tasks[0].acceptanceCriteria).toEqual(['test: the thing builds']);
  });

  it('parses the real SPEC-PRD-0011-P2 file', () => {
    const markdown = readFileSync(
      path.join(__dirname, '..', '..', '..', 'specs/PRD-0011/phase-2-spec.md'),
      'utf-8'
    );
    const doc = parseSpec(markdown);
    expect(doc.id).toBe('SPEC-PRD-0011-P2');
    // The status moves through its ADR-0008 lifecycle as the phase ships;
    // this round-trip test only cares that it parses as a valid status.
    expect(['Draft', 'Approved', 'Done', 'Superseded']).toContain(doc.status);
    expect(doc.tasks).toHaveLength(9);
    expect(doc.envelope.allowedPaths).toContain('sdlc-workflow/**');
  });

  it('rejects a spec without frontmatter', () => {
    expect(() => parseSpec('# no frontmatter')).toThrow(
      expect.objectContaining({ code: 'SPEC_MALFORMED' })
    );
  });

  it('rejects an unknown status', () => {
    expect(() =>
      parseSpec(renderFixture().replace('status: Draft', 'status: Shipped'))
    ).toThrow(expect.objectContaining({ code: 'SPEC_MALFORMED' }));
  });

  it('rejects a spec with a missing envelope field', () => {
    const markdown = renderFixture().replace(/ {2}maxDiffLines: \d+\n/, '');
    expect(() => parseSpec(markdown)).toThrow(
      expect.objectContaining({ code: 'SPEC_MALFORMED' })
    );
  });

  it('parses Prettier-folded multiline envelope arrays', () => {
    // Matches what `prettier --write` emits on long allowedPaths lists —
    // previously left forbiddenSurfaces unset (SPEC_MALFORMED on resume).
    const markdown = [
      '---',
      'id: SPEC-X-P1',
      'prd: PRD-X',
      'phase: 1',
      'status: Approved',
      'envelope:',
      '  allowedPaths:',
      '    [',
      "      'packages/app/frontend/src/auth.ts',",
      "      'packages/app/frontend/src/auth/**',",
      "      'specs/PRD-0004/**',",
      '    ]',
      '  forbiddenSurfaces:',
      "    ['payments-phi-boundary', 'production-deploy', 'ci-config']",
      '  maxDiffLines: 450',
      '  budgetK: 160',
      '---',
      '',
      '# SPEC-X-P1: Multiline envelope.',
      '',
      '## Task T-01: Wire cookies',
      '',
      '- **Complexity:** S',
      '',
      '### Acceptance criteria',
      '',
      '- [ ] test: cookies set'
    ].join('\n');

    const doc = parseSpec(markdown);
    expect(doc.status).toBe('Approved');
    expect(doc.envelope.allowedPaths).toEqual([
      'packages/app/frontend/src/auth.ts',
      'packages/app/frontend/src/auth/**',
      'specs/PRD-0004/**'
    ]);
    expect(doc.envelope.forbiddenSurfaces).toEqual([
      'payments-phi-boundary',
      'production-deploy',
      'ci-config'
    ]);
    expect(doc.envelope.maxDiffLines).toBe(450);
    expect(doc.envelope.budgetK).toBe(160);
  });

  // A naive split(',') shreds a brace glob into two broken halves. In
  // forbiddenSurfaces that is quietly dangerous: neither half matches
  // anything, so the surface the envelope was meant to guard stops being
  // enforced and the gate still reports green.
  it('keeps brace globs and quoted commas intact in envelope arrays', () => {
    const markdown = [
      '---',
      'id: SPEC-X-P1',
      'prd: PRD-X',
      'phase: 1',
      'status: Approved',
      'envelope:',
      '  allowedPaths:',
      "    ['packages/app/backend/src/**/*.{test,spec}.ts', 'docs/**']",
      '  forbiddenSurfaces:',
      "    ['infra/{prod,staging}/**', 'production-deploy']",
      '  maxDiffLines: 100',
      '  budgetK: 40',
      '---',
      '',
      '# SPEC-X-P1: Brace globs.',
      '',
      '## Task T-01: Do it',
      '',
      '- **Complexity:** S',
      '',
      '### Acceptance criteria',
      '',
      '- [ ] test: it works'
    ].join('\n');

    const doc = parseSpec(markdown);

    expect(doc.envelope.allowedPaths).toEqual([
      'packages/app/backend/src/**/*.{test,spec}.ts',
      'docs/**'
    ]);
    expect(doc.envelope.forbiddenSurfaces).toEqual([
      'infra/{prod,staging}/**',
      'production-deploy'
    ]);
  });

  it('does not split a comma inside a quoted envelope entry', () => {
    const markdown = [
      '---',
      'id: SPEC-X-P1',
      'prd: PRD-X',
      'phase: 1',
      'status: Approved',
      'envelope:',
      '  allowedPaths: ["docs/a,b.md", "docs/c.md"]',
      '  forbiddenSurfaces: []',
      '  maxDiffLines: 10',
      '  budgetK: 5',
      '---',
      '',
      '# SPEC-X-P1: Quoted comma.',
      '',
      '## Task T-01: Do it',
      '',
      '- **Complexity:** S',
      '',
      '### Acceptance criteria',
      '',
      '- [ ] test: it works'
    ].join('\n');

    expect(parseSpec(markdown).envelope.allowedPaths).toEqual([
      'docs/a,b.md',
      'docs/c.md'
    ]);
  });

  it('tolerates sparse task metadata and wrapped criteria', () => {
    const markdown = [
      '---',
      'id: SPEC-X-P1',
      'prd: PRD-X',
      'phase: 1',
      'status: Draft',
      'envelope:',
      '  allowedPaths: []',
      '  forbiddenSurfaces: []',
      '  maxDiffLines: 100',
      '  budgetK: 10',
      '---',
      '',
      '# SPEC-X-P1: Sparse.',
      '',
      '## Task T-01: Bare task',
      '',
      '- **Complexity:** XL',
      '',
      '### Acceptance criteria',
      '',
      '- [ ] test: a criterion that',
      '      wraps onto a second line',
      'not a bullet',
      '- [ ] agent: another one'
    ].join('\n');

    const doc = parseSpec(markdown);
    expect(doc.envelope.allowedPaths).toEqual([]);
    expect(doc.tasks[0]).toMatchObject({
      storyId: '',
      complexity: 'M', // unknown value falls back
      dependsOn: [],
      engineeringNotes: ''
    });
    expect(doc.tasks[0].acceptanceCriteria).toEqual([
      'test: a criterion that wraps onto a second line',
      'agent: another one'
    ]);
  });

  it('rejects frontmatter with an empty required field', () => {
    const markdown = renderFixture().replace('id: SPEC-PRD-0099-P1', 'id:');
    expect(() => parseSpec(markdown)).toThrow(
      expect.objectContaining({ code: 'SPEC_MALFORMED' })
    );
  });

  it('rejects a spec with no tasks', () => {
    const markdown = renderFixture().split('## Task')[0];
    expect(() => parseSpec(markdown)).toThrow(
      expect.objectContaining({ code: 'SPEC_MALFORMED' })
    );
  });
});

describe('SpecDocRepository', () => {
  const git = {
    fileAtRef: jest.fn()
  };
  const repo = new SpecDocRepository(git as never);
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'sdlc-spec-'));
    git.fileAtRef.mockReset();
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('reads and parses a spec file', () => {
    const file = path.join(dir, 'spec.md');
    writeFileSync(file, renderFixture());
    expect(repo.read(file).id).toBe('SPEC-PRD-0099-P1');
  });

  it('fails typed when the file does not exist', () => {
    expect(() => repo.read(path.join(dir, 'missing.md'))).toThrow(
      expect.objectContaining({ code: 'SPEC_MALFORMED' })
    );
  });

  it('readAtRef parses the blob from git', () => {
    git.fileAtRef.mockReturnValue(renderFixture());
    const doc = repo.readAtRef('/repo', 'origin/main', 'specs/x.md');
    expect(doc?.id).toBe('SPEC-PRD-0099-P1');
    expect(git.fileAtRef).toHaveBeenCalledWith(
      '/repo',
      'origin/main',
      'specs/x.md'
    );
  });

  it('readAtRef returns null when the path is absent on the ref', () => {
    git.fileAtRef.mockReturnValue(null);
    expect(repo.readAtRef('/repo', 'origin/main', 'specs/x.md')).toBeNull();
  });
});
