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

  // SPEC-PRD-0023-P1 T-06: closeout is the one writer allowed into specs/**,
  // and the privilege is deliberately narrow — an existing file, under a
  // specs/ tree, and nothing else.
  describe('writeCloseout', () => {
    const seed = (): string => {
      repo.writeSpec(repoPath, 'PRD-0099', 1, '- [ ] test: x\n');
      return path.join('specs', 'PRD-0099', 'phase-1-spec.md');
    };

    it('overwrites an existing spec and returns the absolute path', () => {
      const relPath = seed();

      const written = repo.writeCloseout(repoPath, relPath, '- [x] test: x\n');

      expect(written).toBe(path.join(repoPath, relPath));
      expect(readFileSync(written, 'utf-8')).toBe('- [x] test: x\n');
    });

    it('accepts a spec nested under a package directory', () => {
      repo.writeSpec(
        path.join(repoPath, 'engine'),
        'PRD-0099',
        1,
        '- [ ] test: x\n'
      );

      const written = repo.writeCloseout(
        repoPath,
        'engine/specs/PRD-0099/phase-1-spec.md',
        '- [x] test: x\n'
      );

      expect(readFileSync(written, 'utf-8')).toBe('- [x] test: x\n');
    });

    it('accepts a platform-native separator', () => {
      const relPath = seed();

      expect(() =>
        repo.writeCloseout(
          repoPath,
          relPath.split('/').join(path.sep),
          '- [x] test: x\n'
        )
      ).not.toThrow();
    });

    it('refuses a path outside a specs/ tree', () => {
      expect(() =>
        repo.writeCloseout(repoPath, 'README.md', '# owned\n')
      ).toThrow(expect.objectContaining({ code: 'SPEC_INVALID' }));
    });

    it('refuses a traversal that escapes the checkout', () => {
      seed();

      expect(() =>
        repo.writeCloseout(
          repoPath,
          'specs/PRD-0099/../../../etc/hosts',
          'owned\n'
        )
      ).toThrow(
        expect.objectContaining({
          code: 'SPEC_INVALID',
          message: expect.stringContaining('inside the checkout')
        })
      );
    });

    it('refuses an absolute path', () => {
      const relPath = seed();

      expect(() =>
        repo.writeCloseout(repoPath, path.join(repoPath, relPath), 'owned\n')
      ).toThrow(
        expect.objectContaining({
          code: 'SPEC_INVALID',
          message: expect.stringContaining('inside the checkout')
        })
      );
    });

    it('resolves a redundant traversal that stays inside the specs/ tree', () => {
      seed();

      const written = repo.writeCloseout(
        repoPath,
        'specs/PRD-0098/../PRD-0099/phase-1-spec.md',
        '- [x] test: x\n'
      );

      expect(written).toBe(
        path.join(repoPath, 'specs', 'PRD-0099', 'phase-1-spec.md')
      );
    });

    it('refuses to create a spec that does not exist', () => {
      // Closeout records a verdict about work that shipped; it has no business
      // inventing the spec that work was meant to satisfy.
      expect(() =>
        repo.writeCloseout(
          repoPath,
          'specs/PRD-0099/phase-1-spec.md',
          '# invented\n'
        )
      ).toThrow(expect.objectContaining({ code: 'SPEC_INVALID' }));
    });
  });
});
