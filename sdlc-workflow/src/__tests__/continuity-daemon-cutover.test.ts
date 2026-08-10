/**
 * SPEC-PRD-0020-P2 T-05 — retire bash continuity daemon + cut over launchd.
 */
import { execFileSync } from 'child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync
} from 'fs';
import os from 'os';
import path from 'path';
import { DaemonConfigRepository } from '../repositories/daemon-config.repository';
import { DaemonProcessRepository } from '../repositories/daemon-process.repository';
import {
  LEGACY_CONTINUITY_DAEMON_LABEL,
  LaunchdRepository
} from '../repositories/launchd.repository';
import { DaemonLifecycleService } from '../services/daemon-lifecycle.service';

const SCRIPTS_DIR = path.join(
  __dirname,
  '..',
  '..',
  '..',
  'team-setup',
  'templates',
  'root',
  'scripts'
);
const CONTINUITY_DAEMON_SH = path.join(
  SCRIPTS_DIR,
  'sdlc-continuity-daemon.sh'
);
const INSTALL_CONTINUITY_SH = path.join(
  SCRIPTS_DIR,
  'install-continuity-daemon.sh'
);

const writeDaemonConfig = (root: string): void => {
  mkdirSync(path.join(root, '.sdlc'), { recursive: true });
  writeFileSync(
    path.join(root, '.sdlc', 'daemon.json'),
    JSON.stringify({
      activateScript: 'scripts/activate.sh',
      runsDir: 'var/runs',
      defaultPollSeconds: 30,
      headlessRunner: 'test-runner'
    }),
    'utf-8'
  );
};

const legacyFixturePlist = (
  daemonPath: string
): string => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LEGACY_CONTINUITY_DAEMON_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>${daemonPath}</string>
    <string>--once</string>
  </array>
  <key>StartInterval</key>
  <integer>60</integer>
  <key>RunAtLoad</key>
  <true/>
</dict>
</plist>
`;

describe('SPEC-PRD-0020-P2 T-05 continuity daemon cutover', () => {
  it('retired continuity install/daemon scripts exit non-zero with migration guidance and have no live StartInterval tick', () => {
    expect(existsSync(CONTINUITY_DAEMON_SH)).toBe(true);
    expect(existsSync(INSTALL_CONTINUITY_SH)).toBe(true);

    for (const script of [CONTINUITY_DAEMON_SH, INSTALL_CONTINUITY_SH]) {
      const body = readFileSync(script, 'utf-8');
      expect(body).toMatch(/retired|SPEC-PRD-0020-P2 T-05/i);
      expect(body).toMatch(/daemon install/);
      // No live StartInterval LaunchAgent payload or tick implementation.
      expect(body).not.toMatch(/<key>StartInterval<\/key>/);
      expect(body).not.toMatch(/\brelaunch_supervisor\b/);
      expect(body).not.toMatch(/^tick\(\)/m);
      expect(body).not.toMatch(/launchctl bootstrap/);
      expect(body).not.toMatch(/cat >"\$PLIST"/);

      let exitCode: number | null = null;
      let stderr = '';
      try {
        execFileSync('/bin/bash', [script], {
          encoding: 'utf-8',
          stdio: ['ignore', 'pipe', 'pipe']
        });
      } catch (error) {
        const failed = error as {
          status?: number | null;
          stderr?: string | Buffer;
        };
        exitCode = typeof failed.status === 'number' ? failed.status : null;
        stderr =
          typeof failed.stderr === 'string'
            ? failed.stderr
            : Buffer.isBuffer(failed.stderr)
              ? failed.stderr.toString('utf-8')
              : '';
      }
      expect(exitCode).not.toBe(0);
      expect(exitCode).toBe(1);
      expect(stderr).toMatch(/daemon install/);
      expect(stderr).toMatch(/retired/i);
    }
  });

  it('daemon install unloads or removes a fixture legacy com.rosetta.sdlc-daemon plist before loading the KeepAlive agent', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'daemon-cutover-ws-'));
    const plistDir = mkdtempSync(
      path.join(os.tmpdir(), 'daemon-cutover-plist-')
    );
    writeDaemonConfig(root);

    const legacyPath = path.join(
      plistDir,
      `${LEGACY_CONTINUITY_DAEMON_LABEL}.plist`
    );
    writeFileSync(
      legacyPath,
      legacyFixturePlist(CONTINUITY_DAEMON_SH),
      'utf-8'
    );
    expect(existsSync(legacyPath)).toBe(true);
    expect(readFileSync(legacyPath, 'utf-8')).toContain('StartInterval');

    const order: string[] = [];
    const realLaunchd = new LaunchdRepository();
    const launchd: LaunchdRepository = {
      renderPlist: input => realLaunchd.renderPlist(input),
      install: input => {
        order.push(`install:${input.label}`);
        // Legacy must already be gone before KeepAlive load.
        expect(existsSync(legacyPath)).toBe(false);
        return realLaunchd.install(input);
      },
      uninstall: (label, dir) => {
        order.push(`uninstall:${label}`);
        realLaunchd.uninstall(label, dir);
      },
      uninstallLegacyContinuityDaemon: dir => {
        order.push(`legacy:${LEGACY_CONTINUITY_DAEMON_LABEL}`);
        realLaunchd.uninstallLegacyContinuityDaemon(dir);
      }
    } as LaunchdRepository;

    const lifecycle = new DaemonLifecycleService(
      new DaemonConfigRepository(),
      new DaemonProcessRepository(),
      launchd
    );

    const result = lifecycle.install(root, {
      plistDir,
      load: false,
      cliEntry: '/tmp/fake-cli.js',
      program: process.execPath
    });

    expect(order[0]).toBe(`legacy:${LEGACY_CONTINUITY_DAEMON_LABEL}`);
    expect(order).toContain(`install:${result.label}`);
    expect(
      order.indexOf(`legacy:${LEGACY_CONTINUITY_DAEMON_LABEL}`)
    ).toBeLessThan(order.indexOf(`install:${result.label}`));
    expect(existsSync(legacyPath)).toBe(false);
    expect(existsSync(result.plistPath)).toBe(true);
    expect(result.plistXml).toMatch(/KeepAlive[\s\S]*<true\/>/);
    expect(result.plistXml).not.toContain('StartInterval');
    expect(result.label).not.toBe(LEGACY_CONTINUITY_DAEMON_LABEL);
  });

  it('daemon uninstall also removes a leftover legacy com.rosetta.sdlc-daemon plist', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'daemon-cutover-un-'));
    const plistDir = mkdtempSync(
      path.join(os.tmpdir(), 'daemon-cutover-unpl-')
    );
    writeDaemonConfig(root);

    const lifecycle = new DaemonLifecycleService(
      new DaemonConfigRepository(),
      new DaemonProcessRepository(),
      new LaunchdRepository()
    );
    const installed = lifecycle.install(root, {
      plistDir,
      load: false,
      cliEntry: '/tmp/fake-cli.js',
      program: process.execPath
    });

    const legacyPath = path.join(
      plistDir,
      `${LEGACY_CONTINUITY_DAEMON_LABEL}.plist`
    );
    writeFileSync(
      legacyPath,
      legacyFixturePlist(CONTINUITY_DAEMON_SH),
      'utf-8'
    );

    const removed = lifecycle.uninstall(root, { plistDir });
    expect(removed.label).toBe(installed.label);
    expect(existsSync(installed.plistPath)).toBe(false);
    expect(existsSync(legacyPath)).toBe(false);
  });
});
