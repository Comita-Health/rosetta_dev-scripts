import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync
} from 'fs';
import os from 'os';
import path from 'path';
import { DaemonConfigRepository } from '../repositories/daemon-config.repository';
import { DaemonStoreRepository } from '../repositories/daemon-store.repository';
import { RunLockRepository } from '../repositories/run-lock.repository';
import { BlockerService } from '../services/blocker.service';
import {
  ContinuityService,
  DEFAULT_ABANDONED_SECONDS,
  MINIMUM_CONTINUITY_TICK_MILLISECONDS
} from '../services/continuity.service';
import { DaemonLifecycleService } from '../services/daemon-lifecycle.service';
import { ENGINE_RESUME_WAKE_ACTION_ID } from '../services/engine-resume-wake.action';
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
const BLOCKER_SOURCE = path.join(
  __dirname,
  '..',
  'services',
  'blocker.service.ts'
);
const BASH_CONTINUITY = path.join(
  __dirname,
  '..',
  '..',
  '..',
  'team-setup',
  'templates',
  'root',
  'scripts',
  'sdlc-continuity-daemon.sh'
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
    operatorUnstickAttempts: {},
    operatorUnstickOutcomes: {},
    escalateTiers: {},
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
    jest.useRealTimers();
  });

  const build = (input: {
    workspace: string;
    runsDir: string;
    spec?: SpecDocument | null;
    findByTitle?: jest.Mock;
    spawnDetached?: jest.Mock;
    isAlive?: jest.Mock;
    loadState?: (runsDir: string, runId: string) => RunState | null;
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
    const loadState =
      input.loadState ??
      ((_runsDir: string, runId: string) => {
        const file = path.join(input.runsDir, runId, 'state.json');
        if (existsSync(file) === false) {
          return null;
        }
        return JSON.parse(readFileSync(file, 'utf-8')) as RunState;
      });
    const idleSeconds = (runsDir: string, runId: string): number | null => {
      const file = path.join(runsDir, runId, 'state.json');
      try {
        if (existsSync(file) === false) {
          return null;
        }
        const ageMs = Date.now() - statSync(file).mtimeMs;
        return Math.max(0, Math.floor(ageMs / 1_000));
      } catch {
        return null;
      }
    };
    const runStateRepo = { load: loadState, idleSeconds };
    const blockers = new BlockerService(runStateRepo as never, {
      findByTitle,
      create: jest.fn()
    });
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
      runStateRepo as never,
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
      blockers
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
    // Per-workspace ContinuityService path only — never the retired bash tick.
    const spawnSurface = JSON.stringify(spawnDetached.mock.calls);
    expect(spawnSurface).not.toMatch(/sdlc-continuity-daemon\.sh/);
    expect(spawnSurface).not.toMatch(/install-continuity-daemon\.sh/);
    expect(spawnDetached.mock.calls[0][0].command).not.toMatch(/bash$/);

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

  it('a dead-supervisor unfinished run idle beyond the abandoned threshold emits exactly one abandoned wake and is not relaunched', async () => {
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

    const { service, spawnDetached, store } = build({
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
    const abandoned = store
      .listPendingWakes(workspace)
      .filter(
        wake =>
          wake.kind === 'run-supervisor' && wake.signal === 'abandoned:run-old'
      );
    expect(abandoned).toHaveLength(1);
    expect(abandoned[0]?.data).toMatchObject({
      runId: 'run-old',
      signal: 'abandoned'
    });

    await service.tick(workspace);
    expect(spawnDetached).not.toHaveBeenCalled();
    expect(
      store
        .listPendingWakes(workspace)
        .filter(wake => wake.signal === 'abandoned:run-old')
    ).toHaveLength(1);
  });

  it('when engine blockers report resumable after needs-human issues close, a closed wake is committed on the shared inbox path', async () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), 'cont-cleared-'));
    const runsDir = path.join(workspace, 'runs');
    const repoPath = path.join(workspace, 'repo');
    mkdirSync(repoPath, { recursive: true });
    writeDaemonConfig(workspace, runsDir);

    const cleared: ExceptionEntry = {
      trigger: 'merge-blocked',
      taskId: 'T-01',
      context: ['was blocked'],
      recordedAt: '2026-08-10T00:00:00.000Z'
    };
    writeRunFixture({
      runsDir,
      runId: 'run-clear',
      cwd: workspace,
      pid: 9_080,
      state: baseState(
        'run-clear',
        {
          'T-01': taskResult({ taskId: 'T-01', status: 'completed' })
        },
        [cleared]
      )
    });
    writeSuperviseLaunchRecord({
      runsDir,
      runId: 'run-clear',
      argv: ['entry.js', 'run', '--supervise'],
      execArgv: [],
      execPath: process.execPath,
      cwd: workspace,
      repoPath,
      specPath: '/repo/specs/PRD-0020/phase-2-spec.md'
    });

    // findByTitle only sees open issues — null means the needs-human issue closed.
    const { service, spawnDetached, store } = build({
      workspace,
      runsDir,
      spec: baseSpec(['T-01']),
      findByTitle: jest.fn().mockReturnValue(null)
    });

    const result = await service.tick(workspace);
    expect(spawnDetached).not.toHaveBeenCalled();
    expect(result.skipped).toContainEqual({
      runId: 'run-clear',
      reason: 'blockers-cleared'
    });

    const wakes = store
      .listPendingWakes(workspace)
      .filter(
        wake =>
          wake.kind === 'issue-state' &&
          wake.signal === 'closed:blockers-cleared:run-clear'
      );
    expect(wakes).toHaveLength(1);
    expect(wakes[0]?.data).toMatchObject({
      signal: 'closed',
      runId: 'run-clear',
      resumeAction: ENGINE_RESUME_WAKE_ACTION_ID
    });
  });

  it('does not commit a blocker-cleared wake while supervise is still alive', async () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), 'cont-alive-clear-'));
    const runsDir = path.join(workspace, 'runs');
    const repoPath = path.join(workspace, 'repo');
    mkdirSync(repoPath, { recursive: true });
    writeDaemonConfig(workspace, runsDir);

    const cleared: ExceptionEntry = {
      trigger: 'merge-blocked',
      taskId: 'T-01',
      context: ['was blocked'],
      recordedAt: '2026-08-10T00:00:00.000Z'
    };
    writeRunFixture({
      runsDir,
      runId: 'run-alive-clear',
      cwd: workspace,
      pid: 9_081,
      state: baseState(
        'run-alive-clear',
        {
          'T-01': taskResult({ taskId: 'T-01', status: 'completed' })
        },
        [cleared]
      )
    });
    writeSuperviseLaunchRecord({
      runsDir,
      runId: 'run-alive-clear',
      argv: ['entry.js', 'run', '--supervise'],
      execArgv: [],
      execPath: process.execPath,
      cwd: workspace,
      repoPath,
      specPath: '/repo/specs/PRD-0020/phase-2-spec.md'
    });

    const { service, spawnDetached, store } = build({
      workspace,
      runsDir,
      spec: baseSpec(['T-01']),
      findByTitle: jest.fn().mockReturnValue(null),
      isAlive: jest.fn().mockReturnValue(true)
    });

    const result = await service.tick(workspace);
    expect(spawnDetached).not.toHaveBeenCalled();
    expect(result.relaunched).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(
      store
        .listPendingWakes(workspace)
        .filter(wake => wake.signal.startsWith('closed:blockers-cleared:'))
    ).toHaveLength(0);
  });

  it('after a consumed blocker-cleared wake, dead-supervisor relaunch is not permanently skipped', async () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), 'cont-clear-resume-'));
    const runsDir = path.join(workspace, 'runs');
    const repoPath = path.join(workspace, 'repo');
    mkdirSync(repoPath, { recursive: true });
    writeDaemonConfig(workspace, runsDir);

    const cleared: ExceptionEntry = {
      trigger: 'merge-blocked',
      taskId: 'T-01',
      context: ['was blocked'],
      recordedAt: '2026-08-10T00:00:00.000Z'
    };
    writeRunFixture({
      runsDir,
      runId: 'run-after-clear',
      cwd: workspace,
      pid: 9_082,
      state: baseState(
        'run-after-clear',
        {
          'T-01': taskResult({ taskId: 'T-01', status: 'completed' })
        },
        [cleared]
      )
    });
    writeSuperviseLaunchRecord({
      runsDir,
      runId: 'run-after-clear',
      argv: ['entry.js', 'run', '--supervise', '--detach'],
      execArgv: [],
      execPath: process.execPath,
      cwd: workspace,
      repoPath,
      specPath: '/repo/specs/PRD-0020/phase-2-spec.md'
    });

    const { service, spawnDetached, store } = build({
      workspace,
      runsDir,
      spec: baseSpec(['T-01']),
      findByTitle: jest.fn().mockReturnValue(null)
    });

    const first = await service.tick(workspace);
    expect(spawnDetached).not.toHaveBeenCalled();
    expect(first.skipped).toContainEqual({
      runId: 'run-after-clear',
      reason: 'blockers-cleared'
    });
    const pending = store
      .listPendingWakes(workspace)
      .filter(
        wake => wake.signal === 'closed:blockers-cleared:run-after-clear'
      );
    expect(pending).toHaveLength(1);
    const claimed = await store.claimWake(workspace, pending[0]!.id);
    expect(claimed).not.toBeNull();

    // Historical exceptions keep resumable=true, but the wake is consumed —
    // dead-supervisor relaunch must proceed.
    const second = await service.tick(workspace);
    expect(second.relaunched).toEqual(['run-after-clear']);
    expect(spawnDetached).toHaveBeenCalledTimes(1);
    expect(
      second.skipped.some(
        skip =>
          skip.runId === 'run-after-clear' && skip.reason === 'blockers-cleared'
      )
    ).toBe(false);
  });

  it('after a consumed blocker-cleared wake, abandoned idle still applies', async () => {
    const workspace = mkdtempSync(
      path.join(os.tmpdir(), 'cont-clear-abandon-')
    );
    const runsDir = path.join(workspace, 'runs');
    const repoPath = path.join(workspace, 'repo');
    mkdirSync(repoPath, { recursive: true });
    writeDaemonConfig(workspace, runsDir);
    process.env.SDLC_ABANDONED_SECONDS = '60';

    const cleared: ExceptionEntry = {
      trigger: 'merge-blocked',
      taskId: 'T-01',
      context: ['was blocked'],
      recordedAt: '2026-08-10T00:00:00.000Z'
    };
    writeRunFixture({
      runsDir,
      runId: 'run-clear-old',
      cwd: workspace,
      pid: 9_083,
      state: baseState(
        'run-clear-old',
        {
          'T-01': taskResult({ taskId: 'T-01', status: 'completed' })
        },
        [cleared]
      )
    });
    writeSuperviseLaunchRecord({
      runsDir,
      runId: 'run-clear-old',
      argv: ['entry.js', 'run', '--supervise'],
      execArgv: [],
      execPath: process.execPath,
      cwd: workspace,
      repoPath,
      specPath: '/repo/specs/PRD-0020/phase-2-spec.md'
    });
    const stateFile = path.join(runsDir, 'run-clear-old', 'state.json');
    const stale = new Date(
      Date.now() - (DEFAULT_ABANDONED_SECONDS + 120) * 1_000
    );
    utimesSync(stateFile, stale, stale);

    const { service, spawnDetached, store } = build({
      workspace,
      runsDir,
      spec: baseSpec(['T-01']),
      findByTitle: jest.fn().mockReturnValue(null)
    });

    const first = await service.tick(workspace);
    expect(first.skipped).toContainEqual({
      runId: 'run-clear-old',
      reason: 'blockers-cleared'
    });
    const pending = store
      .listPendingWakes(workspace)
      .filter(wake => wake.signal === 'closed:blockers-cleared:run-clear-old');
    expect(pending).toHaveLength(1);
    await store.claimWake(workspace, pending[0]!.id);

    const second = await service.tick(workspace);
    expect(spawnDetached).not.toHaveBeenCalled();
    expect(second.skipped).toContainEqual({
      runId: 'run-clear-old',
      reason: 'abandoned'
    });
    expect(
      store
        .listPendingWakes(workspace)
        .filter(wake => wake.signal === 'abandoned:run-clear-old')
    ).toHaveLength(1);
  });

  it('continuity abandoned/blocker modules call engine readers / EngineResumeWakeAction rather than bash daemon shell logic', () => {
    const continuity = readFileSync(CONTINUITY_SOURCE, 'utf-8');
    const blocker = readFileSync(BLOCKER_SOURCE, 'utf-8');
    expect(continuity).toMatch(/IBlockerService|BlockerService/);
    expect(continuity).toMatch(/ENGINE_RESUME_WAKE_ACTION_ID/);
    expect(continuity).toMatch(/idleSeconds/);
    expect(continuity).toMatch(/commitWatchSignal/);
    expect(blocker).toMatch(/IRunStateRepository/);
    expect(blocker).toMatch(/IIssueRepository/);
    expect(blocker).toMatch(/resumable/);
    for (const source of [continuity, blocker]) {
      expect(source).not.toMatch(/sdlc-continuity-daemon/);
      expect(source).not.toMatch(/wake_emit_once|wake_reset_once/);
      expect(source).not.toMatch(/bunx tsx|python3/);
      expect(source).not.toMatch(
        /child_process|execSync|spawnSync|execFileSync/
      );
      expect(source).not.toMatch(/\bgh issue list\b/);
    }
    // T-05: bash path is a fail-loud stub only — no live tick remains.
    expect(existsSync(BASH_CONTINUITY)).toBe(true);
    const bashBody = readFileSync(BASH_CONTINUITY, 'utf-8');
    expect(bashBody).toMatch(/retired|daemon install/i);
    expect(bashBody).not.toMatch(/\brelaunch_supervisor\b/);
    expect(bashBody).not.toMatch(/\btick\(\)/);
  });

  it('continuity modules watch run/blocker outcomes only and expose no API that performs deploys or Draft→Approved', () => {
    const continuity = readFileSync(CONTINUITY_SOURCE, 'utf-8');
    const blocker = readFileSync(BLOCKER_SOURCE, 'utf-8');
    expect(continuity).toMatch(/export interface IContinuityService/);
    expect(blocker).toMatch(/export interface IBlockerService/);
    expect(blocker).toMatch(/query\(input: BlockerQueryInput\): BlockerReport/);
    for (const source of [continuity, blocker]) {
      expect(source).not.toMatch(/\bChat\b/);
      expect(source).not.toMatch(/\bConversation\b/);
      expect(source).not.toMatch(/cursor-agent/);
      expect(source).not.toMatch(/SandboxDeploy/);
      expect(source).not.toMatch(/CloseoutService|SpecSynthesisService/);
      expect(source).not.toMatch(/status:\s*['"]Approved['"]/);
      expect(source).not.toMatch(/deployCommand|deploy-organization/);
      expect(source).not.toMatch(/Draft\s*→\s*Approved|Draft->Approved/);
      expect(source).not.toMatch(/\.execute\(/);
    }
    // Shared inbox writer only — never a bespoke wake path or second resume.
    expect(continuity).toMatch(/commitWatchSignal/);
    expect(continuity).not.toMatch(/wake-inbox\.repository/);
    expect(continuity).not.toMatch(/\bemitOnce\b/);
    expect(continuity).not.toMatch(
      /EngineResumeWakeAction\.prototype|\.execute\(/
    );
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

  it('skips no-state / missing-pid / unusable-launch runs without spawning', async () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), 'cont-skip-edge-'));
    const runsDir = path.join(workspace, 'runs');
    mkdirSync(path.join(workspace, 'repo'), { recursive: true });
    writeDaemonConfig(workspace, runsDir);

    mkdirSync(path.join(runsDir, 'run-empty'), { recursive: true });

    writeRunFixture({
      runsDir,
      runId: 'run-no-pid',
      cwd: workspace,
      pid: 9_010,
      state: baseState('run-no-pid', {
        'T-01': taskResult({ taskId: 'T-01', status: 'completed' })
      })
    });
    // Invalid / missing pid → quiet no-supervise-pid skip.
    writeFileSync(path.join(runsDir, 'run-no-pid', 'supervise.pid'), '0\n');

    writeRunFixture({
      runsDir,
      runId: 'run-bad-launch',
      cwd: workspace,
      pid: 9_011,
      state: baseState('run-bad-launch', {
        'T-01': taskResult({ taskId: 'T-01', status: 'completed' })
      })
    });
    writeSuperviseLaunchRecord({
      runsDir,
      runId: 'run-bad-launch',
      argv: [],
      execArgv: [],
      execPath: process.execPath,
      cwd: workspace,
      repoPath: path.join(workspace, 'repo'),
      specPath: '/repo/specs/PRD-0020/phase-2-spec.md'
    });

    const { service, spawnDetached } = build({
      workspace,
      runsDir,
      spec: baseSpec(['T-01'])
    });
    const result = await service.tick(workspace);

    expect(spawnDetached).not.toHaveBeenCalled();
    expect(result.relaunched).toEqual([]);
    expect(result.skipped).toEqual(
      expect.arrayContaining([
        { runId: 'run-empty', reason: 'no-state' },
        { runId: 'run-bad-launch', reason: 'launch-unusable' }
      ])
    );
    expect(result.skipped.some(s => s.runId === 'run-no-pid')).toBe(false);
  });

  it('treats missing execPath/cwd and a file cwd as launch-unusable', async () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), 'cont-launch-'));
    const runsDir = path.join(workspace, 'runs');
    mkdirSync(path.join(workspace, 'repo'), { recursive: true });
    writeDaemonConfig(workspace, runsDir);
    const fileCwd = path.join(workspace, 'not-a-dir');
    writeFileSync(fileCwd, 'x\n');

    for (const [runId, launch] of [
      [
        'run-missing-exec',
        {
          argv: ['entry.js', 'run', '--supervise'],
          execPath: path.join(workspace, 'missing-node'),
          cwd: workspace
        }
      ],
      [
        'run-missing-cwd',
        {
          argv: ['entry.js', 'run', '--supervise'],
          execPath: process.execPath,
          cwd: path.join(workspace, 'gone')
        }
      ],
      [
        'run-file-cwd',
        {
          argv: ['entry.js', 'run', '--supervise'],
          execPath: process.execPath,
          cwd: fileCwd
        }
      ]
    ] as const) {
      writeRunFixture({
        runsDir,
        runId,
        cwd: workspace,
        pid: 9_020,
        state: baseState(runId, {
          'T-01': taskResult({ taskId: 'T-01', status: 'completed' })
        })
      });
      writeSuperviseLaunchRecord({
        runsDir,
        runId,
        argv: [...launch.argv],
        execArgv: [],
        execPath: launch.execPath,
        cwd: launch.cwd,
        repoPath: path.join(workspace, 'repo'),
        specPath: '/repo/specs/PRD-0020/phase-2-spec.md'
      });
    }

    const { service, spawnDetached } = build({
      workspace,
      runsDir,
      spec: baseSpec(['T-01'])
    });
    const result = await service.tick(workspace);
    expect(spawnDetached).not.toHaveBeenCalled();
    expect(result.skipped).toEqual(
      expect.arrayContaining([
        { runId: 'run-missing-exec', reason: 'launch-unusable' },
        { runId: 'run-missing-cwd', reason: 'launch-unusable' },
        { runId: 'run-file-cwd', reason: 'launch-unusable' }
      ])
    );
  });

  it('falls back when SDLC_ABANDONED_SECONDS is invalid and still abandons stale runs', async () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), 'cont-abandon-env-'));
    const runsDir = path.join(workspace, 'runs');
    mkdirSync(path.join(workspace, 'repo'), { recursive: true });
    writeDaemonConfig(workspace, runsDir);
    process.env.SDLC_ABANDONED_SECONDS = 'not-a-number';

    writeRunFixture({
      runsDir,
      runId: 'run-stale',
      cwd: workspace,
      pid: 9_030,
      state: baseState('run-stale', {
        'T-01': taskResult({ taskId: 'T-01', status: 'completed' })
      })
    });
    const stateFile = path.join(runsDir, 'run-stale', 'state.json');
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
      runId: 'run-stale',
      reason: 'abandoned'
    });
  });

  it('fails open on issue probe errors and duplicate titles, and relaunches when repoPath is missing', async () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), 'cont-failopen-'));
    const runsDir = path.join(workspace, 'runs');
    mkdirSync(path.join(workspace, 'repo'), { recursive: true });
    writeDaemonConfig(workspace, runsDir);

    const dup: ExceptionEntry = {
      trigger: 'merge-blocked',
      taskId: 'T-01',
      context: ['needs human'],
      recordedAt: '2026-08-10T00:00:00.000Z'
    };
    writeRunFixture({
      runsDir,
      runId: 'run-probe',
      cwd: workspace,
      pid: 9_040,
      state: baseState(
        'run-probe',
        {
          'T-01': taskResult({ taskId: 'T-01', status: 'completed' })
        },
        [dup, { ...dup }]
      )
    });
    writeSuperviseLaunchRecord({
      runsDir,
      runId: 'run-probe',
      argv: ['entry.js', 'run', '--supervise'],
      execArgv: [],
      execPath: process.execPath,
      cwd: workspace,
      repoPath: '',
      specPath: '/repo/specs/PRD-0020/phase-2-spec.md'
    });

    writeRunFixture({
      runsDir,
      runId: 'run-throw',
      cwd: workspace,
      pid: 9_041,
      state: baseState(
        'run-throw',
        {
          'T-01': taskResult({ taskId: 'T-01', status: 'completed' })
        },
        [dup]
      )
    });
    writeSuperviseLaunchRecord({
      runsDir,
      runId: 'run-throw',
      argv: ['entry.js', 'run', '--supervise'],
      execArgv: [],
      execPath: process.execPath,
      cwd: workspace,
      repoPath: path.join(workspace, 'repo'),
      specPath: '/repo/specs/PRD-0020/phase-2-spec.md'
    });

    const findByTitle = jest.fn().mockImplementation(() => {
      throw new Error('gh down');
    });
    const { service, spawnDetached } = build({
      workspace,
      runsDir,
      spec: baseSpec(['T-01']),
      findByTitle
    });

    const result = await service.tick(workspace);
    expect(result.relaunched.sort()).toEqual(['run-probe', 'run-throw']);
    expect(spawnDetached).toHaveBeenCalledTimes(2);
  });

  it('relaunches when the spec is unreadable and records relaunch-failed on spawn errors', async () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), 'cont-nospec-'));
    const runsDir = path.join(workspace, 'runs');
    mkdirSync(path.join(workspace, 'repo'), { recursive: true });
    writeDaemonConfig(workspace, runsDir);
    writeRunFixture({
      runsDir,
      runId: 'run-nospec',
      cwd: workspace,
      pid: 9_050,
      state: baseState('run-nospec', {
        'T-01': taskResult({ taskId: 'T-01', status: 'completed' })
      })
    });

    const { service: okService, spawnDetached: okSpawn } = build({
      workspace,
      runsDir,
      spec: null
    });
    const ok = await okService.tick(workspace);
    expect(ok.relaunched).toEqual(['run-nospec']);
    expect(okSpawn).toHaveBeenCalledTimes(1);

    writeRunFixture({
      runsDir,
      runId: 'run-fail',
      cwd: workspace,
      pid: 9_051,
      state: baseState('run-fail', {
        'T-01': taskResult({ taskId: 'T-01', status: 'completed' })
      })
    });
    const spawnDetached = jest.fn().mockImplementation(() => {
      throw new Error('spawn boom');
    });
    const { service } = build({
      workspace,
      runsDir,
      spec: baseSpec(['T-01']),
      spawnDetached,
      isAlive: jest.fn().mockImplementation((pid: number) => pid === 4242)
    });
    const failed = await service.tick(workspace);
    expect(failed.skipped).toContainEqual({
      runId: 'run-fail',
      reason: 'relaunch-failed:spawn boom'
    });
  });

  it('re-checks liveness under the lock and skips a racing resume without spawning', async () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), 'cont-race-'));
    const runsDir = path.join(workspace, 'runs');
    mkdirSync(path.join(workspace, 'repo'), { recursive: true });
    writeDaemonConfig(workspace, runsDir);
    writeRunFixture({
      runsDir,
      runId: 'run-race',
      cwd: workspace,
      pid: 9_060,
      state: baseState('run-race', {
        'T-01': taskResult({ taskId: 'T-01', status: 'completed' })
      })
    });

    let checks = 0;
    const isAlive = jest.fn().mockImplementation(() => {
      checks += 1;
      // First considerRun probe: dead. Under-lock re-check: alive.
      return checks > 1;
    });
    const { service, spawnDetached } = build({
      workspace,
      runsDir,
      spec: baseSpec(['T-01']),
      isAlive
    });
    const result = await service.tick(workspace);
    expect(spawnDetached).not.toHaveBeenCalled();
    expect(result.relaunched).toEqual([]);
    expect(result.skipped).toEqual([]);
  });

  it('uses idle=0 when state mtime cannot be read and still relaunches', async () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), 'cont-mtime-'));
    const runsDir = path.join(workspace, 'runs');
    mkdirSync(path.join(workspace, 'repo'), { recursive: true });
    writeDaemonConfig(workspace, runsDir);
    writeRunFixture({
      runsDir,
      runId: 'run-mtime',
      cwd: workspace,
      pid: 9_070,
      state: baseState('run-mtime', {
        'T-01': taskResult({ taskId: 'T-01', status: 'completed' })
      })
    });
    const state = baseState('run-mtime', {
      'T-01': taskResult({ taskId: 'T-01', status: 'completed' })
    });
    unlinkSync(path.join(runsDir, 'run-mtime', 'state.json'));

    const { service, spawnDetached } = build({
      workspace,
      runsDir,
      spec: baseSpec(['T-01']),
      loadState: (_runsDir, runId) => (runId === 'run-mtime' ? state : null)
    });

    const result = await service.tick(workspace);
    expect(result.relaunched).toEqual(['run-mtime']);
    expect(spawnDetached).toHaveBeenCalledTimes(1);
  });

  it('scans zero runs when runsDir is missing', async () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), 'cont-noruns-'));
    const runsDir = path.join(workspace, 'runs-missing');
    writeDaemonConfig(workspace, runsDir);
    const { service } = build({
      workspace,
      runsDir,
      spec: baseSpec(['T-01'])
    });
    const result = await service.tick(workspace);
    expect(result).toEqual({ scanned: 0, relaunched: [], skipped: [] });
  });

  it.each([0, -1, 1.5, Number.NaN])(
    'refuses to arm continuity on tickSeconds %p',
    tickSeconds => {
      const workspace = mkdtempSync(path.join(os.tmpdir(), 'cont-badtick-'));
      const { service } = build({
        workspace,
        runsDir: path.join(workspace, 'runs'),
        spec: baseSpec(['T-01'])
      });
      expect(() => service.start(workspace, tickSeconds)).toThrow(TypeError);
    }
  );

  it('ticks on the poll cadence until stopped and logs tick failures', async () => {
    jest.useFakeTimers();
    const workspace = mkdtempSync(path.join(os.tmpdir(), 'cont-loop-'));
    const runsDir = path.join(workspace, 'runs');
    writeDaemonConfig(workspace, runsDir);
    let loads = 0;
    const load = jest.fn().mockImplementation(() => {
      loads += 1;
      if (loads === 1) {
        throw new Error('tick boom');
      }
      return {
        config: {
          workspaceRoot: workspace,
          activateScript: '/a',
          runsDir,
          defaultPollSeconds: 30,
          headlessRunner: 'test'
        },
        paths: {
          stateDir: '',
          pidFile: '',
          logPath: '',
          launchdLabel: ''
        }
      };
    });
    const service = new ContinuityService(
      { load, derivePaths: jest.fn() },
      { load: () => null, idleSeconds: () => null } as never,
      { read: jest.fn(), readAtRef: jest.fn() },
      { spawnDetached: jest.fn(), isAlive: jest.fn() },
      new RunLockRepository(),
      new DaemonStoreRepository(),
      { query: jest.fn() }
    );
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});

    service.start(workspace, 1);
    await jest.advanceTimersByTimeAsync(0);
    expect(load).toHaveBeenCalledTimes(1);
    expect(error.mock.calls.map(call => String(call[0]))).toEqual([
      '[continuity] tick failed: tick boom'
    ]);

    await jest.advanceTimersByTimeAsync(MINIMUM_CONTINUITY_TICK_MILLISECONDS);
    expect(load).toHaveBeenCalledTimes(2);

    service.stop();
    await jest.advanceTimersByTimeAsync(20_000);
    expect(load).toHaveBeenCalledTimes(2);
    expect(jest.getTimerCount()).toBe(0);
    error.mockRestore();
  });

  it('is safe to stop a continuity loop that was never started', () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), 'cont-stop-'));
    const { service } = build({
      workspace,
      runsDir: path.join(workspace, 'runs'),
      spec: baseSpec(['T-01'])
    });
    expect(() => service.stop()).not.toThrow();
  });
});
