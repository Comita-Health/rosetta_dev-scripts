import 'reflect-metadata';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import { SpecFileRepository } from '../repositories/spec-file.repository';

describe('SpecFileRepository', () => {
  const repo = new SpecFileRepository();
  let repoPath: string;

  beforeEach(() => {
    repoPath = mkdtempSync(path.join(os.tmpdir(), 'spec-file-'));
  });

  afterEach(() => rmSync(repoPath, { recursive: true, force: true }));

  it('writes the spec to the ADR-0008 location and returns the path', () => {
    const written = repo.writeSpec(repoPath, 'PRD-0099', 1, '# spec\n');

    expect(written).toBe(
      path.join(repoPath, 'specs', 'PRD-0099', 'phase-1-spec.md')
    );
    expect(readFileSync(written, 'utf-8')).toBe('# spec\n');
  });

  it('refuses to overwrite an existing spec', () => {
    repo.writeSpec(repoPath, 'PRD-0099', 1, '# original\n');

    expect(() =>
      repo.writeSpec(repoPath, 'PRD-0099', 1, '# clobber\n')
    ).toThrow(expect.objectContaining({ code: 'SPEC_EXISTS' }));
    expect(
      readFileSync(
        path.join(repoPath, 'specs', 'PRD-0099', 'phase-1-spec.md'),
        'utf-8'
      )
    ).toBe('# original\n');
  });
});
