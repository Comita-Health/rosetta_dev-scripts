import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'fs';
import { spawnSync } from 'child_process';
import { injectable } from 'inversify';
import os from 'os';
import path from 'path';
import { WorkflowError } from '../types';

export interface LaunchdPlistInput {
  label: string;
  /** Absolute path to the Node/Bun executable. */
  program: string;
  programArguments: string[];
  workingDirectory: string;
  stdoutPath: string;
  stderrPath: string;
  environment?: Record<string, string>;
}

export interface LaunchdInstallInput extends LaunchdPlistInput {
  /** Directory for `*.plist` files (default: `~/Library/LaunchAgents`). */
  plistDir?: string;
  /** When false, write the plist only — do not call launchctl (tests). */
  load?: boolean;
}

export interface LaunchdInstallResult {
  plistPath: string;
  label: string;
  plistXml: string;
  loaded: boolean;
}

/**
 * Generates and loads/unloads a per-workspace launchd agent plist with
 * `KeepAlive=true` (SPEC-PRD-0020-P1 T-01). The process supervisor boundary
 * stays here so Linux/systemd can later swap behind the same install API.
 */
export interface ILaunchdRepository {
  renderPlist(input: LaunchdPlistInput): string;
  install(input: LaunchdInstallInput): LaunchdInstallResult;
  uninstall(label: string, plistDir?: string): void;
}

const xmlEscape = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const defaultPlistDir = (): string =>
  path.join(os.homedir(), 'Library', 'LaunchAgents');

const guiDomain = (): string => {
  if (typeof process.getuid !== 'function') {
    throw new WorkflowError(
      'launchd install requires a POSIX getuid() (macOS)',
      'DAEMON_CONFIG_INVALID'
    );
  }
  const uid: number = process.getuid();
  return `gui/${uid}`;
};

@injectable()
export class LaunchdRepository implements ILaunchdRepository {
  renderPlist(input: LaunchdPlistInput): string {
    const argsXml = input.programArguments
      .map(arg => `    <string>${xmlEscape(arg)}</string>`)
      .join('\n');
    const envEntries = Object.entries(input.environment ?? {});
    const envXml =
      envEntries.length === 0
        ? ''
        : [
            '  <key>EnvironmentVariables</key>',
            '  <dict>',
            ...envEntries.flatMap(([key, value]) => [
              `    <key>${xmlEscape(key)}</key>`,
              `    <string>${xmlEscape(value)}</string>`
            ]),
            '  </dict>'
          ].join('\n') + '\n';

    return [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<plist version="1.0">',
      '<dict>',
      '  <key>Label</key>',
      `  <string>${xmlEscape(input.label)}</string>`,
      '  <key>ProgramArguments</key>',
      '  <array>',
      `    <string>${xmlEscape(input.program)}</string>`,
      argsXml,
      '  </array>',
      '  <key>WorkingDirectory</key>',
      `  <string>${xmlEscape(input.workingDirectory)}</string>`,
      '  <key>KeepAlive</key>',
      '  <true/>',
      '  <key>RunAtLoad</key>',
      '  <true/>',
      envXml,
      '  <key>StandardOutPath</key>',
      `  <string>${xmlEscape(input.stdoutPath)}</string>`,
      '  <key>StandardErrorPath</key>',
      `  <string>${xmlEscape(input.stderrPath)}</string>`,
      '</dict>',
      '</plist>',
      ''
    ].join('\n');
  }

  install(input: LaunchdInstallInput): LaunchdInstallResult {
    const plistDir = input.plistDir ?? defaultPlistDir();
    mkdirSync(plistDir, { recursive: true });
    const plistPath = path.join(plistDir, `${input.label}.plist`);
    const plistXml = this.renderPlist(input);
    writeFileSync(plistPath, plistXml, 'utf-8');

    const shouldLoad = input.load !== false;
    if (shouldLoad) {
      this.bootout(input.label);
      const bootstrap = spawnSync(
        'launchctl',
        ['bootstrap', guiDomain(), plistPath],
        { encoding: 'utf-8' }
      );
      if (bootstrap.status !== 0) {
        throw new WorkflowError(
          `launchctl bootstrap failed for ${input.label}`,
          'DAEMON_CONFIG_INVALID',
          [(bootstrap.stderr || bootstrap.stdout || '').trim()]
        );
      }
      const enable = spawnSync(
        'launchctl',
        ['enable', `${guiDomain()}/${input.label}`],
        { encoding: 'utf-8' }
      );
      if (enable.status !== 0) {
        throw new WorkflowError(
          `launchctl enable failed for ${input.label}`,
          'DAEMON_CONFIG_INVALID',
          [(enable.stderr || enable.stdout || '').trim()]
        );
      }
    }

    return {
      plistPath,
      label: input.label,
      plistXml,
      loaded: shouldLoad
    };
  }

  uninstall(label: string, plistDir?: string): void {
    this.bootout(label);
    const dir = plistDir ?? defaultPlistDir();
    const plistPath = path.join(dir, `${label}.plist`);
    if (existsSync(plistPath)) {
      unlinkSync(plistPath);
    }
  }

  private bootout(label: string): void {
    spawnSync('launchctl', ['bootout', `${guiDomain()}/${label}`], {
      encoding: 'utf-8'
    });
  }
}
