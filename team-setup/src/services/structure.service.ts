import { mkdirSync, symlinkSync, readlinkSync, existsSync, lstatSync, unlinkSync } from 'fs';
import path from 'path';
import chalk from 'chalk';
import { ProjectConfig, SymlinkConfig } from '../types';

export const createDirectories = (baseDir: string, projects: ProjectConfig[]): void => {
  console.log(chalk.bold('\nCreating directories...'));

  for (const project of projects) {
    const dir = path.join(baseDir, project.dir);
    mkdirSync(dir, { recursive: true });
    console.log(chalk.green(`  ✓ ${project.dir}/`));
  }
};

const normalizeSymlink = (entry: string | SymlinkConfig): SymlinkConfig => {
  if (typeof entry === 'string') {
    return { name: entry, target: path.join('..', 'shared', entry), scope: 'project' };
  }
  return entry;
};

const ensureSymlink = (linkPath: string, target: string, displayPath: string): void => {
  if (lstatSync(linkPath, { throwIfNoEntry: false })?.isSymbolicLink()) {
    const currentTarget = readlinkSync(linkPath);
    if (currentTarget === target) {
      console.log(chalk.gray(`  ⊘ ${displayPath} (correct)`));
      return;
    }
    unlinkSync(linkPath);
  } else if (existsSync(linkPath)) {
    console.log(chalk.yellow(`  ⚠ ${displayPath} exists but is not a symlink, skipping`));
    return;
  }

  symlinkSync(target, linkPath);
  console.log(chalk.green(`  ✓ ${displayPath} -> ${target}`));
};

export const createSymlinks = (baseDir: string, projects: ProjectConfig[]): void => {
  const projectsWithSymlinks = projects.filter(p => p.symlinks.length > 0);
  if (projectsWithSymlinks.length === 0) return;

  console.log(chalk.bold('\nCreating symlinks...'));

  for (const project of projectsWithSymlinks) {
    const projectDir = path.join(baseDir, project.dir);

    for (const entry of project.symlinks) {
      const config = normalizeSymlink(entry);

      if (config.scope === 'repo') {
        for (const repo of project.repos) {
          const repoDir = path.join(projectDir, repo.name);
          if (!existsSync(repoDir)) continue;
          const linkPath = path.join(repoDir, config.name);
          const displayPath = `${project.dir}/${repo.name}/${config.name}`;
          ensureSymlink(linkPath, config.target, displayPath);
        }
      } else {
        const linkPath = path.join(projectDir, config.name);
        const displayPath = `${project.dir}/${config.name}`;
        ensureSymlink(linkPath, config.target, displayPath);
      }
    }
  }
};
