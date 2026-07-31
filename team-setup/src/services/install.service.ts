import { execSync } from 'child_process';
import { existsSync } from 'fs';
import path from 'path';
import chalk from 'chalk';
import { ProjectConfig } from '../types';

export const installDeps = (baseDir: string, projects: ProjectConfig[]): void => {
  console.log(chalk.bold('\nInstalling dependencies...'));

  for (const project of projects) {
    for (const repo of project.repos) {
      const repoDir = path.join(baseDir, project.dir, repo.name);
      const packageJson = path.join(repoDir, 'package.json');

      if (!existsSync(packageJson)) continue;

      console.log(chalk.blue(`  ↓ ${project.dir}/${repo.name}...`));
      try {
        execSync('yarn install --frozen-lockfile', {
          cwd: repoDir,
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        console.log(chalk.green(`  ✓ ${project.dir}/${repo.name}`));
      } catch {
        try {
          execSync('yarn install', {
            cwd: repoDir,
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'pipe'],
          });
          console.log(chalk.green(`  ✓ ${project.dir}/${repo.name}`));
        } catch {
          console.log(chalk.yellow(`  ⚠ ${project.dir}/${repo.name}: install failed`));
        }
      }
    }
  }
};
