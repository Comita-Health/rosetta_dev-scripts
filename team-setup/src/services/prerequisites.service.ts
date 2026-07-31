import { execSync } from 'child_process';
import chalk from 'chalk';

interface Prerequisite {
  name: string;
  command: string;
  versionFlag: string;
  minVersion?: string;
  required: boolean;
}

const PREREQUISITES: Prerequisite[] = [
  { name: 'Node.js', command: 'node', versionFlag: '--version', minVersion: '20', required: true },
  { name: 'Yarn', command: 'yarn', versionFlag: '--version', minVersion: '1.22', required: true },
  { name: 'GitHub CLI', command: 'gh', versionFlag: '--version', required: true },
  { name: 'fzf', command: 'fzf', versionFlag: '--version', required: false },
];

export const checkPrerequisites = (): boolean => {
  let allPassed = true;

  for (const prereq of PREREQUISITES) {
    try {
      const output = execSync(`${prereq.command} ${prereq.versionFlag}`, {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
      const version = output.match(/(\d+\.\d+)/)?.[1] ?? output;

      if (prereq.minVersion && !meetsMinVersion(version, prereq.minVersion)) {
        console.log(chalk.red(`✗ ${prereq.name}: ${version} (requires ≥${prereq.minVersion})`));
        allPassed = false;
      } else {
        console.log(chalk.green(`✓ ${prereq.name}: ${version}`));
      }
    } catch {
      if (prereq.required) {
        console.log(chalk.red(`✗ ${prereq.name}: not found`));
        allPassed = false;
      } else {
        console.log(chalk.yellow(`⚠ ${prereq.name}: not found (optional)`));
      }
    }
  }

  try {
    execSync('gh auth status', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
    console.log(chalk.green('✓ GitHub CLI: authenticated'));
  } catch {
    console.log(chalk.red('✗ GitHub CLI: not authenticated (run: gh auth login)'));
    allPassed = false;
  }

  return allPassed;
};

const meetsMinVersion = (actual: string, min: string): boolean => {
  const [aMajor, aMinor = 0] = actual.split('.').map(Number);
  const [mMajor, mMinor = 0] = min.split('.').map(Number);
  return aMajor > mMajor || (aMajor === mMajor && aMinor >= mMinor);
};
