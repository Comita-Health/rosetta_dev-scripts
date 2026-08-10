import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  utimesSync,
  writeFileSync
} from 'fs';
import os from 'os';
import path from 'path';
import { DaemonConfigRepository } from '../repositories/daemon-config.repository';
import { DaemonStoreRepository } from '../repositories/daemon-store.repository';
import { RunLockRepository } from '../repositories/run-lock.repository';
import {
  ContinuityService,
  DEFAULT_ABANDONED_SECONDS
} from '../services/continuity.service';
import { DaemonLifecycleService } from '../services/daemon-lifecycle.service';
import { escalationTitle } from '../services/escalation.service';
import type {
  ExceptionEntry,
  RunState,
  SpecDocument,
  TaskRunResult
} from '../types';
import { writeSuperviseLaunchRecord } from '../utils/launch-record';

const CONTINUITY_SOURCE = path.join(
  __dirname,
  '..',
  'services',
  'continuity.service.ts'
);

const writeDaemonConfig = (root: string, runsDir: string): void => {
  mkdirSync(path.join(root, '.sdlc'), { recursive: true });
  writeFileSync(
    path.join(root, '.sdlc', 'daemon.json'),
    JSON.stringify({
      activateScript: path.join(root, 'activate.sh'),
      runsDir,
      defaultPollSeconds: 30,
      headlessRunner: 'test-runner'
    }),
    'utf-8'
  );
};

const baseSpec = (taskIds: string[]): SpecDocument =>
  ({
    id: 'SPEC-PRD-0020-P2',
    prdId: 'PRD-0020',
    phase: 2,
    status: 'Approved',
    envelope: {
      allowedPaths: ['sdlc-workflow/**'],
      forbiddenSurfaces: [],
      maxDiffLines: 2500,
      budgetK: 250
    },
    tasks: taskIds.map(id => ({
      id,
      storyId: 'S-03',
      phase: 2,
      title: id,
      engineeringNotes: '',
      complexity: 'M',
      dependsOn: [],
      acceptanceCriteria: ['test: x']
    }))
  }) as SpecDocument;

const taskResult = (
  partial: Omit<TaskRunResult, 'recordedAt'> & { recordedAt?: string }
): TaskRunResult => ({
  recordedAt: partial.recordedAt ?? '2026-08-10T00:00:00.000Z',
  ...partial
});

const baseState = (
  runId: string,
  taskResults: RunState['taskResults'],
  exceptions: ExceptionEntry[] = []
): RunState =>
  ({
    runId,
    specId: 'SPEC-PRD-0020-P2',
    specPath: '/repo/specs/PRD-0020/phase-2-spec.md',
    baseSha: 'base',
    taskResults,
    verdicts: [],
    exceptions,
    criterionVerdicts: [],
    steps: {},
    ciFixAttempts: {},
    gateFixAttempts: {},
    remediations: {},
    mergeBlockedRetries: 0,
    tokenSpendK: 0,
    updatedAt: new Date().toISOString()
  }) as RunState;

const writeRunFixture = (input: {
  runsDir: string;
  runId: string;
  state: RunState;
  pid: number;
  cwd: string;
  execPath?: string;
  argv?: string[];
}): void => {
  const runDir = path.join(input.runsDir, input.runId);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    path.join(runDir, 'state.json'),
    `${JSON.stringify(input.state, null, 2)}\n`,
    'utf-8'
  );
  writeFileSync(path.join(runDir, 'supervise.pid'), `${input.pid}\n`);
  writeSuperviseLaunchRecord({
    runsDir: input.runsDir,
    runId: input.runId,
    argv: input.argv ?? ['entry.js', 'run', '--supervise', '--detach'],
    execArgv: [],
    execPath: input.execPath ?? process.execPath,
    cwd: input.cwd,
    repoPath: path.join(input.cwd, 'repo'),
    specPath: input.state.specPath
  });
};

describe('ContinuityService (SPEC-PRD-0020-P2 T-01)', () => {
  const previousAbandoned = process.env.SDLC_ABANDONED_SECONDS;

  afterEach(() => {
    if (previousAbandoned === undefined) {
      delete process.env.SDLC_ABANDONED_SECONDS;
    } else {
      process.env.SDLC_ABANDONED_SECONDS = previousAbandoned;
    }
  });

  const build = (input: {
    workspace: string;
    runsDir: string;
    spec?: SpecDocument | null;
    findByTitle?: jest.Mock;
    spawnDetached?: jest.Mock;
    isAlive?: jest.Mock;
  }): {
    service: ContinuityService;
    store: DaemonStoreRepository;
    spawnDetached: jest.Mock;
    isAlive: jest.Mock;
    findByTitle: jest.Mock;
  } => {
    const store = new DaemonStoreRepository();
    const spawnDetached =
      input.spawnDetached ?? jest.fn().mockReturnValue({ pid: 4242 });
    const isAlive = input.isAlive ?? jest.fn().mockReturnValue(false);
    const findByTitle = input.findByTitle ?? jest.fn().mockReturnValue(null);
    const service = new ContinuityService(
      {
        load: () => ({
          config: {
            workspaceRoot: input.workspace,
            activateScript: '/a',
            runsDir: input.runsDir,
            defaultPollSeconds: 30,
            headlessRunner: 'test'
          },
          paths: {
            stateDir: '',
            pidFile: '',
            logPath: '',
            launchdLabel: ''
          }
        }),
        derivePaths: jest.fn()
      },
      {
        load: (_runsDir: string, runId: string) => {
          const file = path.join(input.runsDir, runId, 'state.json');
          if (existsSync(file) === false) {
            return null;
          }
          return JSON.parse(readFileSync(file, 'utf-8')) as RunState;
        }
      } as never,
      {
        read: () => {
          if (input.spec === null) {
            throw new Error('no spec');
          }
          return input.spec ?? baseSpec(['T-01']);
        },
        readAtRef: jest.fn()
      },
      { spawnDetached, isAlive },
      new RunLockRepository(),
      store,
      { findByTitle, create: jest.fn() }
    );
    return { service, store, spawnDetached, isAlive, findByTitle };
  };

  it('relaunches a dead unfinished run, logs relaunch, and commits one supervisor-restarted wake', async () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), 'cont-relaunch-'));
    const runsDir = path.join(workspace, 'runs');
    mkdirSync(path.join(workspace, 'repo'), { recursive: true });
    writeDaemonConfig(workspace, runsDir);
    writeRunFixture({
      runsDir,
      runId: 'run-live',
      cwd: workspace,
      pid: 9_001,
      state: baseState('run-live', {
        'T-01': taskResult({ taskId: 'T-01', status: 'completed' })
      })
    });

    const alive = new Set<number>();
    const spawnDetached = jest.fn().mockImplementation(() => {
      alive.add(4242);
      return { pid: 4242 };
    });
    const isAlive = jest
      .fn()
      .mockImplementation((pid: number) => alive.has(pid));

    const { service, store } = build({
      workspace,
      runsDir,
      spec: baseSpec(['T-01']),
      spawnDetached,
      isAlive
    });

    const result = await service.tick(workspace);

    expect(result.relaunched).toEqual(['run-live']);
    expect(spawnDetached).toHaveBeenCalledTimes(1);
    expect(spawnDetached.mock.calls[0][0]).toMatchObject({
      command: process.execPath,
      cwd: workspace
    });
    expect(spawnDetached.mock.calls[0][0].args).toEqual(
      expect.arrayContaining(['run', '--supervise', '--detach'])
    );

    const monitor = readFileSync(
      path.join(runsDir, 'run-live', 'monitor.log'),
      'utf-8'
    );
    expect(monitor).toMatch(/\[continuity\] relaunched supervisor as pid 4242/);
    expect(
      readFileSync(
        path.join(runsDir, 'run-live', 'supervise.pid'),
        'utf-8'
      ).trim()
    ).toBe('4242');

    const pending = store.listPendingWakes(workspace);
    const restarted = pending.filter(
      wake =>
        wake.kind === 'run-supervisor' &&
        wake.signal.startsWith('supervisor-restarted:')
    );
    expect(restarted).toHaveLength(1);
    expect(restarted[0]?.data).toMatchObject({
      runId: 'run-live',
      pid: 4242,
      signal: 'supervisor-restarted'
    });

    // Alive supervisor → no second spawn / no second wake.
    const again = await service.tick(workspace);
    expect(again.relaunched).toEqual([]);
    expect(spawnDetached).toHaveBeenCalledTimes(1);
    expect(
      store
        .listPendingWakes(workspace)
        .filter(wake => wake.signal.startsWith('supervisor-restarted:'))
    ).toHaveLength(1);
  });

  it('never relaunches a finished run or a run with unresolved needs-human blockers', async () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), 'cont-skip-'));
    const runsDir = path.join(workspace, 'runs');
    const repoPath = path.join(workspace, 'repo');
    mkdirSync(repoPath, { recursive: true });
    writeDaemonConfig(workspace, runsDir);

    writeRunFixture({
      runsDir,
      runId: 'run-finished',
      cwd: workspace,
      pid: 9_002,
      state: baseState('run-finished', {
        'T-01': taskResult({
          taskId: 'T-01',
          status: 'completed',
          mergedSha: 'abc123'
        })
      })
    });

    const blockedException: ExceptionEntry = {
      trigger: 'merge-blocked',
      taskId: 'T-01',
      context: ['needs human'],
      recordedAt: '2026-08-10T00:00:00.000Z'
    };
    writeRunFixture({
      runsDir,
      runId: 'run-blocked',
      cwd: workspace,
      pid: 9_003,
      state: baseState(
        'run-blocked',
        {
          'T-01': taskResult({ taskId: 'T-01', status: 'completed' })
        },
        [blockedException]
      )
    });
    // Point launch.json repoPath at a real directory for the issue probe.
    writeSuperviseLaunchRecord({
      runsDir,
      runId: 'run-blocked',
      argv: ['entry.js', 'run', '--supervise'],
      execArgv: [],
      execPath: process.execPath,
      cwd: workspace,
      repoPath,
      specPath: '/repo/specs/PRD-0020/phase-2-spec.md'
    });

    const findByTitle = jest.fn().mockImplementation((_repo, title: string) => {
      if (title === escalationTitle('run-blocked', blockedException)) {
        return { url: 'https://github.com/o/r/issues/1', number: 1 };
      }
      return null;
    });

    const { service, spawnDetached } = build({
      workspace,
      runsDir,
      spec: baseSpec(['T-01']),
      findByTitle
    });

    const result = await service.tick(workspace);

    expect(spawnDetached).not.toHaveBeenCalled();
    expect(result.relaunched).toEqual([]);
    expect(result.skipped).toEqual(
      expect.arrayContaining([
        { runId: 'run-finished', reason: 'finished' },
        { runId: 'run-blocked', reason: 'unresolved-blockers' }
      ])
    );
  });

  it('does not relaunch an abandoned dead-supervisor run', async () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), 'cont-abandon-'));
    const runsDir = path.join(workspace, 'runs');
    mkdirSync(path.join(workspace, 'repo'), { recursive: true });
    writeDaemonConfig(workspace, runsDir);
    process.env.SDLC_ABANDONED_SECONDS = '60';

    writeRunFixture({
      runsDir,
      runId: 'run-old',
      cwd: workspace,
      pid: 9_004,
      state: baseState('run-old', {
        'T-01': taskResult({ taskId: 'T-01', status: 'completed' })
      })
    });
    const stateFile = path.join(runsDir, 'run-old', 'state.json');
    const stale = new Date(
      Date.now() - (DEFAULT_ABANDONED_SECONDS + 120) * 1_000
    );
    utimesSync(stateFile, stale, stale);

    const { service, spawnDetached } = build({
      workspace,
      runsDir,
      spec: baseSpec(['T-01'])
    });

    const result = await service.tick(workspace);
    expect(spawnDetached).not.toHaveBeenCalled();
    expect(result.skipped).toContainEqual({
      runId: 'run-old',
      reason: 'abandoned'
    });
  });

  it('constructs no chat or conversation object and performs no deploy or Draft→Approved transition', () => {
    const source = readFileSync(CONTINUITY_SOURCE, 'utf-8');
    expect(source).not.toMatch(/\bChat\b/);
    expect(source).not.toMatch(/\bConversation\b/);
    expect(source).not.toMatch(/cursor-agent/);
    expect(source).not.toMatch(/SandboxDeploy/);
    expect(source).not.toMatch(/CloseoutService|SpecSynthesisService/);
    expect(source).not.toMatch(/status:\s*['"]Approved['"]/);
    expect(source).not.toMatch(/deployCommand|deploy-organization/);
    // Shared inbox writer only — never a bespoke wake path.
    expect(source).toMatch(/commitWatchSignal/);
    expect(source).not.toMatch(/wake-inbox\.repository/);
    expect(source).not.toMatch(/\bemitOnce\b/);
  });

  it('acquires the run lock so dual relaunch is impossible', async () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), 'cont-lock-'));
    const runsDir = path.join(workspace, 'runs');
    mkdirSync(path.join(workspace, 'repo'), { recursive: true });
    writeDaemonConfig(workspace, runsDir);
    writeRunFixture({
      runsDir,
      runId: 'run-locked',
      cwd: workspace,
      pid: 9_005,
      state: baseState('run-locked', {
        'T-01': taskResult({ taskId: 'T-01', status: 'completed' })
      })
    });

    const holder = new RunLockRepository().acquire(
      runsDir,
      'run-locked',
      'manual-resume'
    );
    const { service, spawnDetached } = build({
      workspace,
      runsDir,
      spec: baseSpec(['T-01'])
    });

    const result = await service.tick(workspace);
    expect(spawnDetached).not.toHaveBeenCalled();
    expect(result.skipped).toContainEqual({
      runId: 'run-locked',
      reason: 'lock-held'
    });
    new RunLockRepository().release(holder);
  });

  it('DaemonLifecycleService starts and stops continuity with the poll cadence', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'cont-lifecycle-'));
    writeDaemonConfig(root, path.join(root, 'runs'));
    const continuity = {
      start: jest.fn(),
      tick: jest.fn().mockResolvedValue({
        scanned: 0,
        relaunched: [],
        skipped: []
      }),
      stop: jest.fn()
    };
    const processRepo = {
      ensureState: jest.fn(),
      writePid: jest.fn(),
      readPid: jest.fn(),
      isAlive: jest.fn(),
      clearPid: jest.fn(),
      waitForShutdown: jest.fn().mockResolvedValue(undefined)
    };
    const lifecycle = new DaemonLifecycleService(
      new DaemonConfigRepository(),
      processRepo as never,
      {
        install: jest.fn(),
        uninstall: jest.fn(),
        renderPlist: jest.fn()
      } as never,
      undefined,
      undefined,
      continuity
    );

    await lifecycle.run(root);
    expect(continuity.start).toHaveBeenCalledWith(root, 30);
    expect(continuity.stop).toHaveBeenCalled();
  });

  it('does not leave orphan service files outside the continuity module set', () => {
    // Guard against accidental chat / deploy helper modules for this task.
    const services = readdirSync(path.join(__dirname, '..', 'services'));
    expect(services).toContain('continuity.service.ts');
    expect(services).not.toContain('continuity-chat.service.ts');
  });
});
