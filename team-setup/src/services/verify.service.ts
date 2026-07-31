import { execSync } from 'child_process';
import { existsSync, lstatSync, readlinkSync } from 'fs';
import path from 'path';
import chalk from 'chalk';
import { ProjectConfig, SharedConfig, SymlinkConfig } from '../types';

export const verifySetup = (baseDir: string, projects: ProjectConfig[], sharedConfig: SharedConfig): void => {
  console.log(chalk.bold('\nVerifying workspace...'));
  let issues = 0;

  for (const repo of sharedConfig.sharedRepos) {
    const gitDir = path.join(baseDir, 'shared', repo.name, '.git');
    if (existsSync(gitDir)) {
      console.log(chalk.green(`  ✓ shared/${repo.name}`));
    } else {
      console.log(chalk.red(`  ✗ shared/${repo.name}: missing`));
      issues++;
    }
  }

  for (const repo of sharedConfig.flatRepos) {
    const gitDir = path.join(baseDir, repo.name, '.git');
    if (existsSync(gitDir)) {
      console.log(chalk.green(`  ✓ ${repo.name}`));
    } else {
      console.log(chalk.red(`  ✗ ${repo.name}: missing`));
      issues++;
    }
  }

  for (const project of projects) {
    for (const repo of project.repos) {
      const repoDir = path.join(baseDir, project.dir, repo.name);
      const gitDir = path.join(repoDir, '.git');
      if (existsSync(gitDir)) {
        try {
          execSync(`git -C "${repoDir}" remote get-url origin`, {
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'pipe'],
          });
          console.log(chalk.green(`  ✓ ${project.dir}/${repo.name}`));
        } catch {
          console.log(chalk.yellow(`  ⚠ ${project.dir}/${repo.name}: no remote`));
          issues++;
        }
      } else {
        console.log(chalk.red(`  ✗ ${project.dir}/${repo.name}: not cloned`));
        issues++;
      }
    }

    for (const entry of project.symlinks) {
      const config: SymlinkConfig = typeof entry === 'string'
        ? { name: entry, target: path.join('..', 'shared', entry), scope: 'project' }
        : entry;

      const checkLink = (linkPath: string, displayPath: string): void => {
        const stat = lstatSync(linkPath, { throwIfNoEntry: false });
        if (stat?.isSymbolicLink()) {
          const target = readlinkSync(linkPath);
          const resolvedTarget = path.resolve(path.dirname(linkPath), target);
          if (existsSync(resolvedTarget)) {
            console.log(chalk.green(`  ✓ ${displayPath} -> ${target}`));
          } else {
            console.log(chalk.red(`  ✗ ${displayPath}: broken symlink`));
            issues++;
          }
        } else {
          console.log(chalk.red(`  ✗ ${displayPath}: symlink missing`));
          issues++;
        }
      };

      if (config.scope === 'repo') {
        for (const repo of project.repos) {
          const linkPath = path.join(baseDir, project.dir, repo.name, config.name);
          checkLink(linkPath, `${project.dir}/${repo.name}/${config.name}`);
        }
      } else {
        const linkPath = path.join(baseDir, project.dir, config.name);
        checkLink(linkPath, `${project.dir}/${config.name}`);
      }
    }

    const claudeMd = path.join(baseDir, project.dir, 'CLAUDE.md');
    if (!existsSync(claudeMd)) {
      console.log(chalk.yellow(`  ⚠ ${project.dir}/CLAUDE.md: missing`));
      issues++;
    }
  }

  const rootClaude = path.join(baseDir, 'CLAUDE.md');
  const rootSettings = path.join(baseDir, '.claude', 'settings.json');
  if (!existsSync(rootClaude)) { console.log(chalk.red('  ✗ root CLAUDE.md: missing')); issues++; }
  if (!existsSync(rootSettings)) { console.log(chalk.red('  ✗ root .claude/settings.json: missing')); issues++; }

  console.log('');
  if (issues === 0) {
    console.log(chalk.green.bold('All checks passed ✓'));
  } else {
    console.log(chalk.yellow.bold(`${issues} issue(s) found`));
  }
};
