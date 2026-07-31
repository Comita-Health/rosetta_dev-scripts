#!/usr/bin/env node
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import chalk from 'chalk';
import { LocalFolderEntry, SharedConfig, TrackConfig } from './types';
import { checkPrerequisites } from './services/prerequisites.service';
import { cloneSharedRepos, cloneFlatRepos, cloneRepos } from './services/clone.service';
import { provisionPersonalChronicle, resolveGitHubUser, derivePersonalRepoName } from './services/personal-chronicle.service';
import { createDirectories, createSymlinks } from './services/structure.service';
import { layDownRootConfig, layDownProjectConfig } from './services/config-files.service';
import { generateWorkspaceFile } from './services/workspace.service';
import { installDeps } from './services/install.service';
import { verifySetup } from './services/verify.service';

const CONFIG_DIR = path.resolve(__dirname, 'config');
const TRACKS_DIR = path.resolve(CONFIG_DIR, 'tracks');

const loadSharedConfig = (): SharedConfig => {
  return JSON.parse(readFileSync(path.join(CONFIG_DIR, 'shared.json'), 'utf-8'));
};

const loadTrackConfig = (trackName: string): TrackConfig => {
  const trackFile = path.join(TRACKS_DIR, `${trackName}.json`);
  return JSON.parse(readFileSync(trackFile, 'utf-8'));
};

const loadLocalFolders = (): LocalFolderEntry[] => {
  const localPath = path.join(CONFIG_DIR, 'local.json');
  if (!existsSync(localPath)) return [];
  try {
    const raw = JSON.parse(readFileSync(localPath, 'utf-8'));
    if (Array.isArray(raw?.localFolders)) return raw.localFolders;
  } catch {
    console.warn(chalk.yellow('  ⚠ local.json is malformed — skipping local folders'));
  }
  return [];
};

const listTracks = (): string[] => {
  return readdirSync(TRACKS_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => f.replace('.json', ''));
};

const resolveBaseDir = (baseDir: string): string => {
  return baseDir.replace(/^~/, process.env.HOME || '~');
};

const resolveSharedWithPersonalChronicle = (shared: SharedConfig): SharedConfig => {
  if (!shared.personalChronicle) return shared;
  const login = resolveGitHubUser();
  if (!login) return shared;
  return { ...shared, resolvedPersonalChronicleRepo: derivePersonalRepoName(shared.personalChronicle.namePrefix, login) };
};

const GOTO_ALIAS = `alias gotor="cd ~/projects/rosetta && cd \\$({ echo '. (workspace root)'; echo '..'; find . -maxdepth 3 -name '.git' -type d | sed 's|/\\.git||;s|^\\./||'; } | sort -u | fzf | sed 's/ (workspace root)\$//') && clear"`;
const GOTO_MARKER = '# rosetta goto alias';

const installGotoAlias = (): void => {
  const zshrc = path.join(process.env.HOME || '~', '.zshrc');
  const content: string = existsSync(zshrc) ? readFileSync(zshrc, 'utf-8') : '';

  if (content.includes(GOTO_MARKER)) {
    const updated = content.replace(
      new RegExp(`${GOTO_MARKER}\\n.*\\n`),
      `${GOTO_MARKER}\n${GOTO_ALIAS}\n`
    );
    writeFileSync(zshrc, updated);
    console.log(chalk.green('  ✓ gotor alias updated in ~/.zshrc'));
  } else {
    writeFileSync(zshrc, content.trimEnd() + `\n\n${GOTO_MARKER}\n${GOTO_ALIAS}\n`);
    console.log(chalk.green('  ✓ gotor alias added to ~/.zshrc'));
  }
};

yargs(hideBin(process.argv))
  .command(
    'setup',
    'Bootstrap workspace for a track',
    (yargs) => yargs
      .option('track', { type: 'string', default: 'default', describe: 'Track name' })
      .option('projects', { type: 'string', describe: 'Comma-separated project IDs to setup (default: all)' })
      .option('base-dir', { type: 'string', describe: 'Override base directory' })
      .option('skip-install', { type: 'boolean', default: false, describe: 'Skip yarn install' })
      .option('skip-clone', { type: 'boolean', default: false, describe: 'Skip cloning (structure + config only)' }),
    (argv) => {
      const shared = loadSharedConfig();
      const track = loadTrackConfig(argv.track);
      const baseDir = resolveBaseDir(argv['base-dir'] || shared.baseDir);

      console.log(chalk.bold.blue(`\n🧭  Rosetta Workspace Setup: Track ${track.track}\n`));
      console.log(chalk.gray(`Base directory: ${baseDir}`));
      console.log(chalk.gray(`Track: ${track.track} — ${track.description}\n`));

      console.log(chalk.bold('Checking prerequisites...'));
      if (!checkPrerequisites()) {
        console.log(chalk.red('\nPrerequisite check failed. Install missing tools and try again.'));
        process.exit(1);
      }

      let projects = track.projects;
      if (argv.projects) {
        const ids = argv.projects.split(',');
        projects = projects.filter(p => ids.includes(p.id));
      }

      createDirectories(baseDir, projects);

      if (!argv['skip-clone']) {
        cloneSharedRepos(shared.sharedRepos, baseDir, shared.org);
        for (const project of projects) {
          console.log(chalk.bold(`\nCloning ${project.id} repos...`));
          cloneRepos(project.repos, baseDir, project.dir, shared.org);
        }
        cloneFlatRepos(shared.flatRepos, baseDir, shared.org);
        if (shared.personalChronicle) {
          provisionPersonalChronicle(shared.personalChronicle, baseDir, shared.org);
        }
      }

      createSymlinks(baseDir, projects);
      layDownRootConfig(baseDir);
      layDownProjectConfig(baseDir, projects);

      console.log(chalk.bold('\nGenerating workspace file...'));
      generateWorkspaceFile(baseDir, track.projects, resolveSharedWithPersonalChronicle(shared));

      if (!argv['skip-install']) {
        installDeps(baseDir, projects);
      }

      console.log(chalk.bold('\nInstalling shell alias...'));
      installGotoAlias();

      console.log(chalk.bold.green('\n✓ Setup complete!'));
      console.log(chalk.gray('\nRun `source ~/.zshrc` or open a new terminal to use `gotor`.'));
      console.log(chalk.gray('Run `yarn dev -- verify` to check health.'));
    }
  )
  .command(
    'update-config',
    'Refresh config files from templates',
    (yargs) => yargs
      .option('track', { type: 'string', default: 'default' })
      .option('base-dir', { type: 'string' }),
    (argv) => {
      const shared = loadSharedConfig();
      const track = loadTrackConfig(argv.track);
      const baseDir = resolveBaseDir(argv['base-dir'] || shared.baseDir);

      console.log(chalk.bold.blue(`\nUpdating config for track: ${track.track}\n`));

      layDownRootConfig(baseDir);
      layDownProjectConfig(baseDir, track.projects);

      console.log(chalk.bold('\nGenerating workspace file...'));
      const localFolders = loadLocalFolders();
      generateWorkspaceFile(baseDir, track.projects, resolveSharedWithPersonalChronicle(shared), localFolders);

      console.log(chalk.bold.green('\n✓ Config updated!'));
    }
  )
  .command(
    'verify',
    'Check workspace health',
    (yargs) => yargs
      .option('track', { type: 'string', default: 'default' })
      .option('base-dir', { type: 'string' }),
    (argv) => {
      const shared = loadSharedConfig();
      const track = loadTrackConfig(argv.track);
      const baseDir = resolveBaseDir(argv['base-dir'] || shared.baseDir);
      verifySetup(baseDir, track.projects, shared);
    }
  )
  .command(
    'tracks',
    'List available tracks',
    () => {},
    () => {
      console.log(chalk.bold('\nAvailable tracks:\n'));
      for (const name of listTracks()) {
        const track = loadTrackConfig(name);
        console.log(`  ${chalk.green(name)} — ${track.description}`);
      }
      console.log('');
    }
  )
  .command(
    'shell-alias',
    'Install gotor alias into ~/.zshrc',
    () => {},
    () => {
      installGotoAlias();
      console.log(chalk.gray(`\n  ${GOTO_ALIAS}\n`));
      console.log(chalk.gray('  Run `source ~/.zshrc` or open a new terminal to use it.'));
    }
  )
  .demandCommand(1, 'You must specify a command')
  .strict()
  .help()
  .parse();
