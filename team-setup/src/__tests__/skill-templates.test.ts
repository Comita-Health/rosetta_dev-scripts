import { readdirSync, readFileSync } from 'fs';
import path from 'path';

const ROOT = path.resolve(__dirname, '..', '..', 'templates', 'root');

const read = (rel: string): string =>
  readFileSync(path.join(ROOT, rel), 'utf-8');

const frontMatter = (rel: string): string => read(rel).split('---')[1] ?? '';

describe('skill templates', () => {
  it('ships identical Claude and Cursor copies of local-delivery', () => {
    const files = readdirSync(
      path.join(ROOT, '.claude', 'skills', 'local-delivery')
    ).sort();
    expect(files).toEqual(['SKILL.md', 'reviewer-prompt.md']);
    expect(
      readdirSync(path.join(ROOT, '.cursor', 'skills', 'local-delivery')).sort()
    ).toEqual(files);
    for (const file of files) {
      expect(read(`.cursor/skills/local-delivery/${file}`)).toBe(
        read(`.claude/skills/local-delivery/${file}`)
      );
    }
  });

  it.each([
    '.claude/skills/pr-checks-watch/SKILL.md',
    '.cursor/skills/pr-checks-watch/SKILL.md',
    '.claude/skills/deploy-verify-watch/SKILL.md',
    '.cursor/skills/deploy-verify-watch/SKILL.md'
  ])('%s is opt-in in its catalog description', rel => {
    expect(frontMatter(rel)).toContain('Gha-mode repos only');
  });

  it('local-delivery reads every repo command from the contract', () => {
    const skill = read('.claude/skills/local-delivery/SKILL.md');
    for (const key of [
      '.ci.command',
      '.ci.statusCommand',
      '.ci.reviewChecklist',
      '.sandbox.localDeployCommand'
    ]) {
      expect(skill).toContain(key);
    }
    expect(skill).toContain('drop.json');
  });
});
