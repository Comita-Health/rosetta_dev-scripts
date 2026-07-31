import { cpSync, mkdirSync, existsSync } from 'fs';
import path from 'path';
import chalk from 'chalk';
import { ProjectConfig } from '../types';

const TEMPLATES_DIR = path.resolve(__dirname, '..', '..', 'templates');

export const layDownRootConfig = (baseDir: string): void => {
  console.log(chalk.bold('\nLaying down root config...'));

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

  const claudeDir = path.join(rootTemplateDir, '.claude');
  if (existsSync(claudeDir)) {
    cpSync(claudeDir, path.join(baseDir, '.claude'), { recursive: true });
    console.log(chalk.green('  ✓ .claude/ (settings, commands, rules)'));
  }
};

export const layDownProjectConfig = (baseDir: string, projects: ProjectConfig[]): void => {
  console.log(chalk.bold('\nLaying down project CLAUDE.md files...'));

  for (const project of projects) {
    const templateFile = path.join(TEMPLATES_DIR, 'projects', `${project.id}.CLAUDE.md`);
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
