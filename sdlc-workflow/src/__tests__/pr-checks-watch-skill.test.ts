import { createHash } from 'crypto';
import { existsSync, readFileSync, readdirSync } from 'fs';
import path from 'path';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const CURSOR_SKILL = path.join(
  REPO_ROOT,
  'team-setup/templates/root/.cursor/skills/pr-checks-watch'
);
const CLAUDE_SKILL = path.join(
  REPO_ROOT,
  'team-setup/templates/root/.claude/skills/pr-checks-watch'
);

const listFilesRecursive = (root: string): string[] => {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else {
        out.push(path.relative(root, full));
      }
    }
  };
  walk(root);
  return out.sort();
};

const sha256 = (file: string): string =>
  createHash('sha256').update(readFileSync(file)).digest('hex');

describe('pr-checks-watch skill templates', () => {
  it('keeps .cursor and .claude skill trees content-identical', () => {
    expect(existsSync(CURSOR_SKILL)).toBe(true);
    expect(existsSync(CLAUDE_SKILL)).toBe(true);

    const cursorFiles = listFilesRecursive(CURSOR_SKILL);
    const claudeFiles = listFilesRecursive(CLAUDE_SKILL);
    expect(cursorFiles).toEqual(claudeFiles);

    for (const rel of cursorFiles) {
      expect(sha256(path.join(CURSOR_SKILL, rel))).toBe(
        sha256(path.join(CLAUDE_SKILL, rel))
      );
    }
  });

  it('emits a Cursor wake sentinel and remediates failures without merging', () => {
    const script = readFileSync(
      path.join(CURSOR_SKILL, 'scripts/watch-pr-checks.sh'),
      'utf-8'
    );
    const skill = readFileSync(path.join(CURSOR_SKILL, 'SKILL.md'), 'utf-8');

    expect(script).toMatch(/AGENT_LOOP_WAKE_pr_checks/);
    expect(script).toMatch(/checks_failed/);
    expect(script).toMatch(/"pr", "view"/);
    expect(skill).toMatch(/Do \*\*not\*\* merge/);
    expect(skill).toMatch(/pr-approve-watch/);
    expect(skill).not.toMatch(/gh pr merge/);
  });
});
