import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync
} from 'fs';
import { Container } from 'inversify';
import os from 'os';
import path from 'path';
import { DaemonHandler } from '../handlers/daemon.handler';
import { DaemonConfigRepository } from '../repositories/daemon-config.repository';
import {
  DaemonProcessRepository,
  type IDaemonProcessRepository
} from '../repositories/daemon-process.repository';
import { LaunchdRepository } from '../repositories/launchd.repository';
import {
  DaemonLifecycleService,
  type IDaemonLifecycleService
} from '../services/daemon-lifecycle.service';
import type { IPollSchedulerService } from '../services/poll-scheduler.service';
import { WORKFLOW_TOKENS } from '../tokens';
import { WorkflowError } from '../types';

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

const buildHandler = (): DaemonHandler => {
  const container = new Container();
  container
    .bind(WORKFLOW_TOKENS.DaemonConfigRepository)
    .to(DaemonConfigRepository);
  container
    .bind(WORKFLOW_TOKENS.DaemonProcessRepository)
    .to(DaemonProcessRepository);
  container.bind(WORKFLOW_TOKENS.LaunchdRepository).to(LaunchdRepository);
  container
    .bind(WORKFLOW_TOKENS.DaemonLifecycleService)
    .to(DaemonLifecycleService);
  container.bind(WORKFLOW_TOKENS.DaemonStatusService).toConstantValue({
    build: () => {
      throw new Error('status not used in lifecycle tests');
    }
  });
  container.bind(WORKFLOW_TOKENS.WatchRegistryService).toConstantValue({
    register: jest.fn(),
    get: jest.fn(),
    getByTarget: jest.fn(),
    list: jest.fn(),
    recordPoll: jest.fn(),
    recordPollFailure: jest.fn(),
    expire: jest.fn()
  });
  container.bind(WORKFLOW_TOKENS.LegacyWakeMigrateService).toConstantValue({
    migrate: jest.fn()
  });
  container.bind(WORKFLOW_TOKENS.DaemonHandler).to(DaemonHandler);
  return container.get(WORKFLOW_TOKENS.DaemonHandler);
};

describe('DaemonHandler install / uninstall (launchd plist)', () => {
  it('writes a KeepAlive=true plist with a workspace-unique label', () => {
    const handler = buildHandler();
    const a = mkdtempSync(path.join(os.tmpdir(), 'daemon-inst-a-'));
    const b = mkdtempSync(path.join(os.tmpdir(), 'daemon-inst-b-'));
    const plistDir = mkdtempSync(path.join(os.tmpdir(), 'daemon-plist-'));
    writeDaemonConfig(a);
    writeDaemonConfig(b);

    const left = handler.install({
      workspaceRoot: a,
      plistDir,
      load: false,
      cliEntry: '/tmp/fake-cli.js',
      program: process.execPath
    });
    const right = handler.install({
      workspaceRoot: b,
      plistDir,
      load: false,
      cliEntry: '/tmp/fake-cli.js',
      program: process.execPath
    });

    expect(left.label).not.toBe(right.label);
    expect(left.plistXml).toContain('<key>KeepAlive</key>');
    expect(left.plistXml).toContain('<true/>');
    expect(left.plistXml).toContain(`<string>${left.label}</string>`);
    expect(right.plistXml).toContain(`<string>${right.label}</string>`);
    expect(left.plistXml).toContain(a);
    expect(right.plistXml).toContain(b);
    expect(existsSync(left.plistPath)).toBe(true);
    expect(existsSync(right.plistPath)).toBe(true);
    expect(left.plistPath).not.toBe(right.plistPath);

    const leftBody = readFileSync(left.plistPath, 'utf-8');
    const rightBody = readFileSync(right.plistPath, 'utf-8');
    expect(leftBody).toMatch(/KeepAlive[\s\S]*<true\/>/);
    expect(rightBody).toMatch(/KeepAlive[\s\S]*<true\/>/);
    expect(leftBody).not.toBe(rightBody);

    handler.uninstall({ workspaceRoot: a, plistDir });
    handler.uninstall({ workspaceRoot: b, plistDir });
    expect(existsSync(left.plistPath)).toBe(false);
    expect(existsSync(right.plistPath)).toBe(false);
  });

  it('fails install without a workspace root and writes no plist', () => {
    const handler = buildHandler();
    const plistDir = mkdtempSync(path.join(os.tmpdir(), 'daemon-plist-none-'));

    expect(() =>
      handler.install({ workspaceRoot: undefined, plistDir, load: false })
    ).toThrow(WorkflowError);
    expect(() =>
      handler.install({ workspaceRoot: '', plistDir, load: false })
    ).toThrow(/requires --workspace/);
    expect(readdirSync(plistDir)).toEqual([]);
  });

  it('runs and uninstalls through the handler surface', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'daemon-handler-run-'));
    writeDaemonConfig(root);
    const mockLifecycle: IDaemonLifecycleService = {
      run: jest.fn().mockResolvedValue({
        stateDir: path.join(root, '.sdlc', 'daemon'),
        pidFile: path.join(root, '.sdlc', 'daemon', 'daemon.pid'),
        logPath: path.join(root, '.sdlc', 'daemon', 'daemon.log'),
        launchdLabel: 'sdlc.workflow.daemon.test'
      }),
      install: jest.fn(),
      uninstall: jest
        .fn()
        .mockReturnValue({ label: 'sdlc.workflow.daemon.test' })
    };
    const mockStatus = { build: jest.fn() };
    const mockRegistry = {
      register: jest.fn(),
      get: jest.fn(),
      getByTarget: jest.fn(),
      list: jest.fn(),
      recordPoll: jest.fn(),
      recordPollFailure: jest.fn(),
      expire: jest.fn()
    };
    const mockConfig = {
      derivePaths: jest.fn(),
      load: jest.fn()
    };
    const mockMigrate = { migrate: jest.fn() };
    const handler = new DaemonHandler(
      mockLifecycle,
      mockStatus,
      mockRegistry,
      mockConfig,
      mockMigrate
    );

    await handler.run({ workspaceRoot: root });
    expect(mockLifecycle.run).toHaveBeenCalledWith(root);

    const removed = handler.uninstall({ workspaceRoot: root });
    expect(removed.label).toBe('sdlc.workflow.daemon.test');
    expect(mockLifecycle.uninstall).toHaveBeenCalledWith(root, {
      plistDir: undefined
    });
  });
});

describe('DaemonProcessRepository', () => {
  it('writes pid + log paths and clears the pid file', () => {
    const repo = new DaemonProcessRepository();
    const dir = mkdtempSync(path.join(os.tmpdir(), 'daemon-proc-'));
    const pidFile = path.join(dir, 'daemon.pid');
    const logPath = path.join(dir, 'daemon.log');

    repo.writePid({ pidFile, logPath, pid: 4242 });
    expect(repo.readPid(pidFile)).toBe(4242);
    expect(existsSync(logPath)).toBe(true);
    repo.clearPid(pidFile, 4242);
    expect(existsSync(pidFile)).toBe(false);
  });

  it('isAlive probes the current process', () => {
    const repo = new DaemonProcessRepository();
    expect(repo.isAlive(process.pid)).toBe(true);
    expect(repo.isAlive(2_147_483_646)).toBe(false);
  });

  it('leaves a foreign pid file untouched when clearing', () => {
    const repo = new DaemonProcessRepository();
    const dir = mkdtempSync(path.join(os.tmpdir(), 'daemon-proc-foreign-'));
    const pidFile = path.join(dir, 'daemon.pid');
    const logPath = path.join(dir, 'daemon.log');
    repo.writePid({ pidFile, logPath, pid: 111 });
    repo.clearPid(pidFile, 222);
    expect(repo.readPid(pidFile)).toBe(111);
    expect(repo.readPid(path.join(dir, 'missing.pid'))).toBeNull();
    writeFileSync(pidFile, 'not-a-pid\n', 'utf-8');
    expect(repo.readPid(pidFile)).toBeNull();
    repo.clearPid(pidFile);
    expect(existsSync(pidFile)).toBe(false);
    repo.clearPid(path.join(dir, 'already-gone.pid'));
  });

  it('resolves waitForShutdown when SIGTERM is emitted', async () => {
    const repo = new DaemonProcessRepository();
    const done = repo.waitForShutdown();
    process.emit('SIGTERM');
    await done;
  });
});

describe('LaunchdRepository renderPlist', () => {
  it('escapes XML and includes environment variables', () => {
    const repo = new LaunchdRepository();
    const xml = repo.renderPlist({
      label: 'sdlc.workflow.daemon.test',
      program: '/bin/echo',
      programArguments: ['a&b', '<c>', '"d"'],
      workingDirectory: '/tmp/ws',
      stdoutPath: '/tmp/out',
      stderrPath: '/tmp/err',
      environment: { PATH: '/usr/bin', HOME: '/tmp/home' }
    });
    expect(xml).toContain('<key>KeepAlive</key>');
    expect(xml).toContain('<true/>');
    expect(xml).toContain('a&amp;b');
    expect(xml).toContain('&lt;c&gt;');
    expect(xml).toContain('&quot;d&quot;');
    expect(xml).toContain('<key>PATH</key>');
    expect(xml).toContain('/usr/bin');
  });

  it('omits EnvironmentVariables when none are provided', () => {
    const repo = new LaunchdRepository();
    const xml = repo.renderPlist({
      label: 'sdlc.workflow.daemon.bare',
      program: '/bin/echo',
      programArguments: [],
      workingDirectory: '/tmp',
      stdoutPath: '/tmp/o',
      stderrPath: '/tmp/e'
    });
    expect(xml).not.toContain('EnvironmentVariables');
  });
});

describe('DaemonLifecycleService.run', () => {
  it('writes the pid file, waits for shutdown, then clears it', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'daemon-run-'));
    writeDaemonConfig(root);

    const configRepo = new DaemonConfigRepository();
    const { paths } = configRepo.load(root);
    const processRepo: IDaemonProcessRepository = {
      ensureState: jest.fn(),
      writePid: jest.fn(),
      readPid: jest.fn(),
      isAlive: jest.fn(),
      clearPid: jest.fn(),
      waitForShutdown: jest.fn().mockResolvedValue(undefined)
    };
    const poller: IPollSchedulerService = {
      start: jest.fn(),
      tick: jest.fn().mockResolvedValue(undefined),
      stop: jest.fn()
    };
    const consumer = {
      start: jest.fn(),
      tick: jest.fn().mockResolvedValue({ claimed: [], actionFailures: [] }),
      stop: jest.fn()
    };
    const lifecycle = new DaemonLifecycleService(
      configRepo,
      processRepo,
      new LaunchdRepository(),
      poller,
      consumer
    );

    const result = await lifecycle.run(root);

    expect(result.pidFile).toBe(paths.pidFile);
    expect(processRepo.writePid).toHaveBeenCalledWith({
      pidFile: paths.pidFile,
      logPath: paths.logPath
    });
    expect(processRepo.waitForShutdown).toHaveBeenCalled();
    expect(poller.start).toHaveBeenCalledWith(root, 30);
    expect(consumer.start).toHaveBeenCalledWith(root, 30);
    expect(poller.stop).toHaveBeenCalled();
    expect(consumer.stop).toHaveBeenCalled();
    expect(processRepo.clearPid).toHaveBeenCalledWith(
      paths.pidFile,
      process.pid
    );
  });

  it('install uses default program and cliEntry when omitted', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'daemon-defaults-'));
    writeDaemonConfig(root);
    const plistDir = mkdtempSync(path.join(os.tmpdir(), 'daemon-plist-def-'));
    const lifecycle = new DaemonLifecycleService(
      new DaemonConfigRepository(),
      new DaemonProcessRepository(),
      new LaunchdRepository()
    );

    const result = lifecycle.install(root, { plistDir, load: false });
    expect(result.plistXml).toContain(process.execPath);
    expect(result.loaded).toBe(false);
  });

  it('install creates the daemon state directory and log before launchd load', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'daemon-install-state-'));
    writeDaemonConfig(root);
    const plistDir = mkdtempSync(path.join(os.tmpdir(), 'daemon-plist-state-'));
    const configRepo = new DaemonConfigRepository();
    const { paths } = configRepo.load(root);
    expect(existsSync(paths.stateDir)).toBe(false);
    expect(existsSync(paths.logPath)).toBe(false);

    const lifecycle = new DaemonLifecycleService(
      configRepo,
      new DaemonProcessRepository(),
      new LaunchdRepository()
    );
    lifecycle.install(root, { plistDir, load: false });

    expect(existsSync(paths.stateDir)).toBe(true);
    expect(existsSync(paths.logPath)).toBe(true);
    expect(existsSync(paths.pidFile)).toBe(false);
  });

  it('uninstall recovers from a missing daemon.json via derived label only', () => {
    const root = mkdtempSync(
      path.join(os.tmpdir(), 'daemon-uninstall-orphan-')
    );
    writeDaemonConfig(root);
    const plistDir = mkdtempSync(
      path.join(os.tmpdir(), 'daemon-plist-orphan-')
    );
    const configRepo = new DaemonConfigRepository();
    const lifecycle = new DaemonLifecycleService(
      configRepo,
      new DaemonProcessRepository(),
      new LaunchdRepository()
    );

    const installed = lifecycle.install(root, { plistDir, load: false });
    expect(existsSync(installed.plistPath)).toBe(true);

    // Simulate a deleted/moved contract — uninstall must not call load().
    unlinkSync(path.join(root, '.sdlc', 'daemon.json'));
    writeFileSync(path.join(root, '.sdlc', 'daemon.json'), '{', 'utf-8');

    expect(() => configRepo.load(root)).toThrow(/Malformed daemon config/);

    const removed = lifecycle.uninstall(root, { plistDir });
    expect(removed.label).toBe(installed.label);
    expect(existsSync(installed.plistPath)).toBe(false);
  });
});
