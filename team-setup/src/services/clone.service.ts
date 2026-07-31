import { execSync } from 'child_process';
import { existsSync } from 'fs';
import path from 'path';
import chalk from 'chalk';
import { RepoConfig } from '../types';

export const cloneRepo = (
  repo: RepoConfig,
  targetDir: string,
  org: string
): boolean => {
  const gitDir = path.join(targetDir, '.git');

  if (existsSync(gitDir)) {
    console.log(chalk.gray(`  ⊘ ${repo.name} (already cloned)`));
    return true;
  }

  try {
    console.log(chalk.blue(`  ↓ Cloning ${repo.ghRepo}...`));
    execSync(`gh repo clone ${org}/${repo.ghRepo} "${targetDir}"`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe']
    });
    console.log(chalk.green(`  ✓ ${repo.name}`));
    return true;
  } catch (err) {
    console.log(chalk.red(`  ✗ ${repo.name}: clone failed`));
    if (err instanceof Error) {
      console.log(chalk.red(`    ${err.message.split('\n')[0]}`));
    }
    return false;
  }
};

export const cloneRepos = (
  repos: RepoConfig[],
  baseDir: string,
  subDir: string,
  org: string
): void => {
  for (const repo of repos) {
    const targetDir = path.join(baseDir, subDir, repo.name);
    cloneRepo(repo, targetDir, org);
  }
};

export const cloneSharedRepos = (
  repos: RepoConfig[],
  baseDir: string,
  org: string
): void => {
  if (repos.length === 0) return;
  console.log(chalk.bold('\nCloning shared repos...'));
  cloneRepos(repos, baseDir, 'shared', org);
};

export const cloneFlatRepos = (
  repos: RepoConfig[],
  baseDir: string,
  org: string
): void => {
  if (repos.length === 0) return;
  console.log(chalk.bold('\nCloning flat repos...'));
  for (const repo of repos) {
    const targetDir = path.join(baseDir, repo.name);
    cloneRepo(repo, targetDir, org);
  }
};
