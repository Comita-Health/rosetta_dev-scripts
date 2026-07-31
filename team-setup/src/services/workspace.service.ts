import { writeFileSync } from 'fs';
import path from 'path';
import chalk from 'chalk';
import { LocalFolderEntry, ProjectConfig, SharedConfig } from '../types';

export const generateWorkspaceFile = (
  baseDir: string,
  projects: ProjectConfig[],
  sharedConfig: SharedConfig,
  localFolders: LocalFolderEntry[] = []
): void => {
  const folders: { path: string; name?: string }[] = [];

  for (const repo of sharedConfig.sharedRepos) {
    const entry: { path: string; name?: string } = { path: path.join('shared', repo.name) };
    if (repo.label) entry.name = repo.label;
    folders.push(entry);
  }

  for (const project of projects) {
    for (const repo of project.repos) {
      const entry: { path: string; name?: string } = { path: path.join(project.dir, repo.name) };
      if (repo.label) entry.name = repo.label;
      folders.push(entry);
    }
  }

  for (const repo of sharedConfig.flatRepos) {
    const entry: { path: string; name?: string } = { path: repo.name };
    if (repo.label) entry.name = repo.label;
    folders.push(entry);
  }

  for (const entry of localFolders) {
    const folder: { path: string; name?: string } = { path: entry.path };
    if (entry.name) folder.name = entry.name;
    folders.push(folder);
  }

  if (sharedConfig.resolvedPersonalChronicleRepo) {
    const entry: { path: string; name?: string } = {
      path: sharedConfig.resolvedPersonalChronicleRepo,
    };
    if (sharedConfig.personalChronicle?.label) {
      entry.name = sharedConfig.personalChronicle.label;
    }
    folders.push(entry);
  }

  const workspace = { folders };
  writeFileSync(
    path.join(baseDir, 'all.code-workspace'),
    JSON.stringify(workspace, null, 2) + '\n'
  );
  console.log(chalk.green('  ✓ all.code-workspace'));
};
