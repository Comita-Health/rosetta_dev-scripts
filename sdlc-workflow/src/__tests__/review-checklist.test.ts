import 'reflect-metadata';
import { execSync } from 'child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { GitRepository } from '../repositories/git.repository';
import { ReviewChecklistRepository } from '../repositories/review-checklist.repository';
import { parseReviewChecklist } from '../utils/review-checklist';

describe('parseReviewChecklist', () => {
  it('parses checkbox items (mandatory marker, case-insensitive, trimmed), ignoring prose', () => {
    const checklist = parseReviewChecklist(
      '# Checklist\n\n- [ ]   Every new HSR class has TSDoc   (MANDATORY)  \n* [x] Prefer readability over cleverness'
    );

    expect(checklist.items).toEqual([
      { text: 'Every new HSR class has TSDoc', mandatory: true },
      { text: 'Prefer readability over cleverness', mandatory: false }
    ]);
  });

  it('fails loud with a named error on zero checkbox items or an empty item', () => {
    expect(() => parseReviewChecklist('# Checklist\n\nTBD.')).toThrow(
      expect.objectContaining({ code: 'CONTRACT_MALFORMED' })
    );
    expect(() => parseReviewChecklist('- [ ] Real item\n- [ ]   \n')).toThrow(
      expect.objectContaining({ code: 'CONTRACT_MALFORMED' })
    );
  });
});

const sh = (cwd: string, cmd: string): string =>
  execSync(cmd, { cwd, encoding: 'utf-8' });

const commitChecklist = (dir: string, markdown: string): void => {
  mkdirSync(path.join(dir, '.sdlc'), { recursive: true });
  writeFileSync(path.join(dir, '.sdlc', 'review-checklist.md'), markdown);
  sh(dir, 'git add -A && git commit -q -m "chore: review checklist"');
};

describe('ReviewChecklistRepository (SPEC-BUG-reviewer-house-bar-P1 T-01)', () => {
  const repo = new ReviewChecklistRepository(new GitRepository());
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'sdlc-review-checklist-'));
    sh(
      dir,
      'git init -q && git config user.email t@t && git config user.name t && git commit --allow-empty -q -m init'
    );
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('returns null when the ref carries no review-checklist.md', () => {
    expect(repo.loadAtRef(dir, 'HEAD')).toBeNull();
  });

  it('loads the committed blob, ignoring uncommitted local edits (tree-resolution rule)', () => {
    commitChecklist(dir, '- [ ] Real mandatory bar (mandatory)\n');
    // Local tampering: a working-copy edit must not sway the verdict.
    writeFileSync(
      path.join(dir, '.sdlc', 'review-checklist.md'),
      '- [ ] Watered-down bar\n'
    );

    expect(repo.loadAtRef(dir, 'HEAD')).toEqual({
      items: [{ text: 'Real mandatory bar', mandatory: true }]
    });
  });

  it('throws a named CONTRACT_MALFORMED error for a checklist with no checkbox items', () => {
    commitChecklist(dir, '# Review Checklist\n\nTBD.\n');

    expect(() => repo.loadAtRef(dir, 'HEAD')).toThrow(
      expect.objectContaining({ code: 'CONTRACT_MALFORMED' })
    );
  });
});
