import {
  cpSync,
  mkdirSync,
  existsSync,
  readdirSync,
  readFileSync,
  writeFileSync
} from 'fs';
import path from 'path';
import chalk from 'chalk';
import { ProjectConfig } from '../types';

const TEMPLATES_DIR = path.resolve(__dirname, '..', '..', 'templates');

/**
 * Escape a string for a YAML double-quoted scalar used in .mdc frontmatter.
 */
const yamlDoubleQuoted = (value: string): string =>
  `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/**
 * Mirror Claude Code rules/commands into Cursor `.cursor/rules/*.mdc` so both
 * agents share one content source under templates/root/.claude/.
 */
const mirrorClaudeRulesToCursor = (
  baseDir: string,
  claudeDir: string
): void => {
  const cursorRulesDir = path.join(baseDir, '.cursor', 'rules');
  mkdirSync(cursorRulesDir, { recursive: true });

  const rulesDir = path.join(claudeDir, 'rules');
  if (existsSync(rulesDir)) {
    for (const file of readdirSync(rulesDir)) {
      if (!file.endsWith('.md')) continue;
      const body = readFileSync(path.join(rulesDir, file), 'utf-8').trimEnd();
      const stem = file.replace(/\.md$/, '');
      const description =
        stem === 'architecture-hsr'
          ? 'Mandatory Handler / Service / Repository + InversifyJS architecture'
          : stem === 'code-style'
            ? 'TypeScript and Prettier code style for Rosetta'
            : stem === 'inline-docs'
              ? 'TSDoc / JSDoc bar for backend HSR classes and frontend exports (SDLC)'
              : stem === 'sdlc-run-supervise'
                ? 'Default: background-supervise sdlc-workflow runs (--supervise --detach + heartbeat)'
                : `Rosetta rule: ${stem}`;
      const contents = [
        '---',
        `description: ${yamlDoubleQuoted(description)}`,
        'alwaysApply: true',
        '---',
        '',
        body,
        ''
      ].join('\n');
      writeFileSync(path.join(cursorRulesDir, `${stem}.mdc`), contents);
    }
  }

  const commandsDir = path.join(claudeDir, 'commands');
  if (existsSync(commandsDir)) {
    for (const file of readdirSync(commandsDir)) {
      if (!file.endsWith('.md')) continue;
      const body = readFileSync(
        path.join(commandsDir, file),
        'utf-8'
      ).trimEnd();
      const stem = file.replace(/\.md$/, '');
      const firstLine =
        body.split('\n')[0]?.trim() || `Run the ${stem} workflow`;
      const contents = [
        '---',
        `description: ${yamlDoubleQuoted(firstLine)}`,
        'alwaysApply: false',
        '---',
        '',
        `# /${stem} (Cursor)`,
        '',
        body,
        ''
      ].join('\n');
      writeFileSync(path.join(cursorRulesDir, `command-${stem}.mdc`), contents);
    }
  }

  console.log(chalk.green('  ✓ .cursor/rules/ (mirrored from .claude/)'));
};

export const layDownRootConfig = (baseDir: string): void => {
  console.log(
    chalk.bold('\nLaying down root agent config (Claude Code + Cursor)...')
  );

  const rootTemplateDir = path.join(TEMPLATES_DIR, 'root');

  if (!existsSync(rootTemplateDir)) {
    console.log(chalk.yellow('  ⚠ No root templates found, skipping'));
    return;
  }

  const claudeMdSrc = path.join(rootTemplateDir, 'CLAUDE.md');
  if (existsSync(claudeMdSrc)) {
    cpSync(claudeMdSrc, path.join(baseDir, 'CLAUDE.md'));
    console.log(chalk.green('  ✓ CLAUDE.md'));
  }

  const agentsMdSrc = path.join(rootTemplateDir, 'AGENTS.md');
  if (existsSync(agentsMdSrc)) {
    cpSync(agentsMdSrc, path.join(baseDir, 'AGENTS.md'));
    console.log(chalk.green('  ✓ AGENTS.md'));
  }

  const claudeDir = path.join(rootTemplateDir, '.claude');
  if (existsSync(claudeDir)) {
    cpSync(claudeDir, path.join(baseDir, '.claude'), { recursive: true });
    console.log(chalk.green('  ✓ .claude/ (settings, commands, rules)'));
  }

  const cursorDir = path.join(rootTemplateDir, '.cursor');
  if (existsSync(cursorDir)) {
    mkdirSync(path.join(baseDir, '.cursor'), { recursive: true });
    // Copy static Cursor files (cli.json, skills/, …); rules are generated below.
    for (const entry of readdirSync(cursorDir)) {
      if (entry === 'rules') continue;
      const src = path.join(cursorDir, entry);
      cpSync(src, path.join(baseDir, '.cursor', entry), { recursive: true });
    }
    console.log(chalk.green('  ✓ .cursor/ (cli.json, skills/, …)'));
  }

  if (existsSync(claudeDir)) {
    mirrorClaudeRulesToCursor(baseDir, claudeDir);
  }
};

export const layDownProjectConfig = (
  baseDir: string,
  projects: ProjectConfig[]
): void => {
  console.log(chalk.bold('\nLaying down project CLAUDE.md files...'));

  for (const project of projects) {
    const templateFile = path.join(
      TEMPLATES_DIR,
      'projects',
      `${project.id}.CLAUDE.md`
    );
    const targetFile = path.join(baseDir, project.dir, 'CLAUDE.md');

    if (!existsSync(templateFile)) {
      console.log(chalk.yellow(`  ⚠ No template for ${project.id}, skipping`));
      continue;
    }

    mkdirSync(path.join(baseDir, project.dir), { recursive: true });
    cpSync(templateFile, targetFile);
    console.log(chalk.green(`  ✓ ${project.dir}/CLAUDE.md`));

    const extraDir = path.join(TEMPLATES_DIR, 'projects', project.id);
    if (existsSync(extraDir)) {
      cpSync(extraDir, path.join(baseDir, project.dir), { recursive: true });
      console.log(chalk.green(`  ✓ ${project.dir}/ (extra files)`));
    }
  }
};
