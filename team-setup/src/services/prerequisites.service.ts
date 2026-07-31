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
  {
    name: 'Node.js',
    command: 'node',
    versionFlag: '--version',
    minVersion: '20',
    required: true
  },
  {
    name: 'Yarn',
    command: 'yarn',
    versionFlag: '--version',
    minVersion: '1.22',
    required: true
  },
  {
    name: 'GitHub CLI',
    command: 'gh',
    versionFlag: '--version',
    required: true
  },
  { name: 'fzf', command: 'fzf', versionFlag: '--version', required: false }
];

/**
 * Soft agent-tool checks. Contributors need Claude Code and/or Cursor Agent CLI.
 * Missing both is a warning (setup still proceeds) so non-AI git work is possible.
 */
const checkAgentTools = (): void => {
  const agents: Array<{
    name: string;
    command: string;
    versionFlag: string;
    hint: string;
  }> = [
    {
      name: 'Claude Code',
      command: 'claude',
      versionFlag: '--version',
      hint: 'Install: https://docs.anthropic.com/en/docs/claude-code'
    },
    {
      name: 'Cursor Agent CLI',
      command: 'agent',
      versionFlag: '--version',
      hint: 'Install: curl https://cursor.com/install -fsS | bash  then: agent login'
    }
  ];

  let found = 0;
  for (const agent of agents) {
    try {
      const output = execSync(`${agent.command} ${agent.versionFlag}`, {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe']
      }).trim();
      const version = output.match(/(\d+\.\d+)/)?.[1] ?? output.split('\n')[0];
      console.log(chalk.green(`✓ ${agent.name}: ${version}`));
      found += 1;
    } catch {
      console.log(
        chalk.yellow(
          `⚠ ${agent.name}: not found (optional if the other agent is installed)`
        )
      );
      console.log(chalk.gray(`  ${agent.hint}`));
    }
  }

  if (found === 0) {
    console.log(
      chalk.yellow(
        '⚠ No AI agent CLI detected. Install Claude Code and/or Cursor Agent CLI for the full Rosetta workflow.'
      )
    );
  }
};

export const checkPrerequisites = (): boolean => {
  let allPassed = true;

  for (const prereq of PREREQUISITES) {
    try {
      const output = execSync(`${prereq.command} ${prereq.versionFlag}`, {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe']
      }).trim();
      const version = output.match(/(\d+\.\d+)/)?.[1] ?? output;

      if (prereq.minVersion && !meetsMinVersion(version, prereq.minVersion)) {
        console.log(
          chalk.red(
            `✗ ${prereq.name}: ${version} (requires ≥${prereq.minVersion})`
          )
        );
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
    execSync('gh auth status', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe']
    });
    console.log(chalk.green('✓ GitHub CLI: authenticated'));
  } catch {
    console.log(
      chalk.red('✗ GitHub CLI: not authenticated (run: gh auth login)')
    );
    allPassed = false;
  }

  checkAgentTools();

  return allPassed;
};

const meetsMinVersion = (actual: string, min: string): boolean => {
  const [aMajor, aMinor = 0] = actual.split('.').map(Number);
  const [mMajor, mMinor = 0] = min.split('.').map(Number);
  return aMajor > mMajor || (aMajor === mMajor && aMinor >= mMinor);
};
