import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  utimesSync,
  writeFileSync
} from 'fs';
import os from 'os';
import path from 'path';
import { DaemonStoreRepository } from '../repositories/daemon-store.repository';
import { ContinuityService } from '../services/continuity.service';
import {
  DEFAULT_AGENT_STALL_SECONDS,
  StaleAgentService,
  killAgentsForRun
} from '../services/stale-agent.service';
import { RunLockRepository } from '../repositories/run-lock.repository';
import type { RunState, SpecDocument, TaskRunResult } from '../types';
import { writeSuperviseLaunchRecord } from '../utils/launch-record';

const STALE_SOURCE = path.join(
  __dirname,
  '..',
  'services',
  'stale-agent.service.ts'
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
  taskResults: RunState['taskResults']
): RunState =>
  ({
    runId,
    specId: 'SPEC-PRD-0020-P2',
    specPath: '/repo/specs/PRD-0020/phase-2-spec.md',
    baseSha: 'base',
    taskResults,
    verdicts: [],
    exceptions: [],
    criterionVerdicts: [],
    steps: {},
    ciFixAttempts: {},
    gateFixAttempts: {},
    remediations: {},
    mergeBlockedRetries: 0,
    tokenSpendK: 0,
    updatedAt: new Date().toISOString()
  }) as RunState;

const writeRunState = (
  runsDir: string,
  runId: string,
  state: RunState
): void => {
  const runDir = path.join(runsDir, runId);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    path.join(runDir, 'state.json'),
    `${JSON.stringify(state, null, 2)}\n`,
    'utf-8'
  );
  writeSuperviseLaunchRecord({
    runsDir,
    runId,
    argv: ['entry.js', 'run', '--supervise', '--detach'],
    execArgv: [],
    execPath: process.execPath,
    cwd: runsDir,
    repoPath: path.join(runsDir, 'repo'),
    specPath: state.specPath
  });
};

const unfinishedState = (runId: string): RunState =>
  baseState(runId, {
    'T-01': taskResult({ taskId: 'T-01', status: 'completed' })
  });

const finishedState = (runId: string): RunState =>
  baseState(runId, {
    'T-01': taskResult({
      taskId: 'T-01',
      status: 'completed',
      mergedSha: 'abc123'
    })
  });

const writeHeartbeat = (
  runsDir: string,
  runId: string,
  snapshot: Record<string, unknown>,
  ageSeconds?: number
): string => {
  const runDir = path.join(runsDir, runId);
  mkdirSync(runDir, { recursive: true });
  const hb = path.join(runDir, 'heartbeat.jsonl');
  writeFileSync(hb, `${JSON.stringify(snapshot)}\n`, 'utf-8');
  if (ageSeconds !== undefined) {
    const past = new Date(Date.now() - ageSeconds * 1_000);
    utimesSync(hb, past, past);
  }
  return hb;
};

describe('StaleAgentService (SPEC-PRD-0020-P2 T-02)', () => {
  const previousStall = process.env.SDLC_AGENT_STALL_SECONDS;
  const previousBin = process.env.CURSOR_AGENT_BIN;

  afterEach(() => {
    if (previousStall === undefined) {
      delete process.env.SDLC_AGENT_STALL_SECONDS;
    } else {
      process.env.SDLC_AGENT_STALL_SECONDS = previousStall;
    }
    if (previousBin === undefined) {
      delete process.env.CURSOR_AGENT_BIN;
    } else {
      process.env.CURSOR_AGENT_BIN = previousBin;
    }
  });

  const build = (
    workspace: string,
    runsDir: string,
    options?: {
      spec?: SpecDocument | null;
    }
  ): {
    service: StaleAgentService;
    store: DaemonStoreRepository;
    killForRun: jest.Mock;
  } => {
    const store = new DaemonStoreRepository();
    const service = new StaleAgentService(
      {
        load: () => ({
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
        }),
        derivePaths: jest.fn()
      },
      store,
      {
        load: (_runsDir: string, runId: string) => {
          const file = path.join(runsDir, runId, 'state.json');
          if (existsSync(file) === false) {
            return null;
          }
          return JSON.parse(readFileSync(file, 'utf-8')) as RunState;
        }
      } as never,
      {
        read: () => {
          if (options?.spec === null) {
            throw new Error('no spec');
          }
          return options?.spec ?? baseSpec(['T-01']);
        },
        readAtRef: jest.fn()
      }
    );
    const killForRun = jest.fn();
    service.killForRun = killForRun;
    return { service, store, killForRun };
  };

  it('kills once and emits one agent-stalled wake for a stalled implementation heartbeat', async () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), 'stale-kill-'));
    const runsDir = path.join(workspace, 'runs');
    writeDaemonConfig(workspace, runsDir);
    process.env.SDLC_AGENT_STALL_SECONDS = '60';

    writeRunState(runsDir, 'run-stale', unfinishedState('run-stale'));
    writeHeartbeat(
      runsDir,
      'run-stale',
      {
        ts: '2026-08-10T00:00:00.000Z',
        runId: 'run-stale',
        step: 'implementation',
        agentAlive: true
      },
      120
    );

    const { service, store, killForRun } = build(workspace, runsDir);
    const result = await service.tick(workspace);

    expect(result.killed).toEqual(['run-stale']);
    expect(killForRun).toHaveBeenCalledTimes(1);
    expect(killForRun).toHaveBeenCalledWith({
      runId: 'run-stale',
      runsDir
    });

    const stalled = store
      .listPendingWakes(workspace)
      .filter(
        wake =>
          wake.kind === 'run-supervisor' &&
          wake.signal.startsWith('agent-stalled:')
      );
    expect(stalled).toHaveLength(1);
    expect(stalled[0]?.data).toMatchObject({
      runId: 'run-stale',
      signal: 'agent-stalled'
    });
    expect(typeof stalled[0]?.data?.stalledSeconds).toBe('number');
    expect(Number(stalled[0]?.data?.stalledSeconds) > 60).toBe(true);

    const monitor = readFileSync(
      path.join(runsDir, 'run-stale', 'monitor.log'),
      'utf-8'
    );
    expect(monitor).toMatch(
      /\[continuity\] implementation agent stalled \d+s — killing/
    );
  });

  it('does not kill or emit a wake for a healthy or non-implementation heartbeat', async () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), 'stale-healthy-'));
    const runsDir = path.join(workspace, 'runs');
    writeDaemonConfig(workspace, runsDir);
    process.env.SDLC_AGENT_STALL_SECONDS = '60';

    writeRunState(runsDir, 'run-fresh', unfinishedState('run-fresh'));
    writeHeartbeat(
      runsDir,
      'run-fresh',
      {
        ts: '2026-08-10T12:00:00.000Z',
        runId: 'run-fresh',
        step: 'implementation',
        agentAlive: true
      },
      10
    );
    writeRunState(runsDir, 'run-review', unfinishedState('run-review'));
    writeHeartbeat(
      runsDir,
      'run-review',
      {
        ts: '2026-08-10T00:00:00.000Z',
        runId: 'run-review',
        step: 'reviewer',
        agentAlive: true
      },
      120
    );
    writeRunState(runsDir, 'run-idle-agent', unfinishedState('run-idle-agent'));
    writeHeartbeat(
      runsDir,
      'run-idle-agent',
      {
        ts: '2026-08-10T00:00:00.000Z',
        runId: 'run-idle-agent',
        step: 'implementation',
        agentAlive: false
      },
      120
    );

    const { service, store, killForRun } = build(workspace, runsDir);
    const result = await service.tick(workspace);

    expect(killForRun).not.toHaveBeenCalled();
    expect(result.killed).toEqual([]);
    expect(
      store
        .listPendingWakes(workspace)
        .filter(wake => wake.signal.startsWith('agent-stalled:'))
    ).toHaveLength(0);
  });

  it('does not re-kill or re-emit until the heartbeat recovers and stalls again', async () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), 'stale-rearm-'));
    const runsDir = path.join(workspace, 'runs');
    writeDaemonConfig(workspace, runsDir);
    process.env.SDLC_AGENT_STALL_SECONDS = '60';

    writeRunState(runsDir, 'run-loop', unfinishedState('run-loop'));
    writeHeartbeat(
      runsDir,
      'run-loop',
      {
        ts: '2026-08-10T00:00:00.000Z',
        runId: 'run-loop',
        step: 'implementation',
        agentAlive: true
      },
      120
    );

    const { service, store, killForRun } = build(workspace, runsDir);

    await service.tick(workspace);
    await service.tick(workspace);
    await service.tick(workspace);

    expect(killForRun).toHaveBeenCalledTimes(1);
    expect(
      store
        .listPendingWakes(workspace)
        .filter(wake => wake.signal.startsWith('agent-stalled:'))
    ).toHaveLength(1);

    // Heartbeat recovers (fresh implementation snapshot).
    writeHeartbeat(
      runsDir,
      'run-loop',
      {
        ts: '2026-08-10T01:00:00.000Z',
        runId: 'run-loop',
        step: 'implementation',
        agentAlive: true
      },
      5
    );
    await service.tick(workspace);
    expect(killForRun).toHaveBeenCalledTimes(1);

    // New stall episode with a new heartbeat ts → second kill + wake.
    writeHeartbeat(
      runsDir,
      'run-loop',
      {
        ts: '2026-08-10T02:00:00.000Z',
        runId: 'run-loop',
        step: 'implementation',
        agentAlive: true
      },
      120
    );
    await service.tick(workspace);

    expect(killForRun).toHaveBeenCalledTimes(2);
    expect(
      killForRun.mock.calls.every(call => call[0].runId === 'run-loop')
    ).toBe(true);
    expect(
      store
        .listPendingWakes(workspace)
        .filter(wake => wake.signal.startsWith('agent-stalled:'))
    ).toHaveLength(2);
  });

  it('skips finished runs and runs without usable state before kill/wake', async () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), 'stale-finished-'));
    const runsDir = path.join(workspace, 'runs');
    writeDaemonConfig(workspace, runsDir);
    process.env.SDLC_AGENT_STALL_SECONDS = '60';

    // Completed run whose last heartbeat still looks in-flight + stalled.
    writeRunState(runsDir, 'run-done', finishedState('run-done'));
    writeHeartbeat(
      runsDir,
      'run-done',
      {
        ts: '2026-08-10T00:00:00.000Z',
        runId: 'run-done',
        step: 'implementation',
        agentAlive: true
      },
      120
    );

    // Heartbeat present but no state.json — bash continuity skips entirely.
    writeHeartbeat(
      runsDir,
      'run-no-state',
      {
        ts: '2026-08-10T00:00:00.000Z',
        runId: 'run-no-state',
        step: 'implementation',
        agentAlive: true
      },
      120
    );

    const { service, store, killForRun } = build(workspace, runsDir);
    const result = await service.tick(workspace);

    expect(killForRun).not.toHaveBeenCalled();
    expect(result.killed).toEqual([]);
    expect(result.skipped).toEqual(
      expect.arrayContaining([
        { runId: 'run-done', reason: 'finished' },
        { runId: 'run-no-state', reason: 'no-state' }
      ])
    );
    expect(
      store
        .listPendingWakes(workspace)
        .filter(wake => wake.signal.startsWith('agent-stalled:'))
    ).toHaveLength(0);
  });

  it('uses DEFAULT_AGENT_STALL_SECONDS when the env override is invalid', async () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), 'stale-default-'));
    const runsDir = path.join(workspace, 'runs');
    writeDaemonConfig(workspace, runsDir);
    process.env.SDLC_AGENT_STALL_SECONDS = 'not-a-number';

    writeRunState(runsDir, 'run-default', unfinishedState('run-default'));
    writeHeartbeat(
      runsDir,
      'run-default',
      {
        ts: '2026-08-10T00:00:00.000Z',
        runId: 'run-default',
        step: 'implementation',
        agentAlive: true
      },
      DEFAULT_AGENT_STALL_SECONDS + 30
    );

    const { service, killForRun } = build(workspace, runsDir);
    const result = await service.tick(workspace);
    expect(result.killed).toEqual(['run-default']);
    expect(killForRun).toHaveBeenCalledTimes(1);
  });

  it('scopes the default killer pattern to the agent binary and runId', () => {
    const source = readFileSync(STALE_SOURCE, 'utf-8');
    expect(source).toMatch(/pkill/);
    expect(source).toMatch(/escapeRegExp\(agentBinary\(\)\)/);
    expect(source).toMatch(/escapeRegExp\(runId\)/);
    expect(source).not.toMatch(/pgrep\s+-lf\s+cursor-agent/);
    expect(source).toMatch(/commitWatchSignal/);
    expect(source).toMatch(/allTasksMerged/);
    expect(typeof killAgentsForRun).toBe('function');
  });

  it('skips missing runsDir and unreadable heartbeats without killing', async () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), 'stale-skip-'));
    const runsDir = path.join(workspace, 'runs-missing');
    writeDaemonConfig(workspace, runsDir);
    const { service: emptyService, killForRun: emptyKill } = build(
      workspace,
      runsDir
    );
    expect(await emptyService.tick(workspace)).toEqual({
      scanned: 0,
      killed: [],
      skipped: []
    });
    expect(emptyKill).not.toHaveBeenCalled();

    const presentRuns = path.join(workspace, 'runs');
    writeRunState(presentRuns, 'run-bad', unfinishedState('run-bad'));
    writeFileSync(
      path.join(presentRuns, 'run-bad', 'heartbeat.jsonl'),
      'not-json\n',
      'utf-8'
    );
    const past = new Date(Date.now() - 120 * 1_000);
    utimesSync(
      path.join(presentRuns, 'run-bad', 'heartbeat.jsonl'),
      past,
      past
    );

    writeRunState(presentRuns, 'run-empty', unfinishedState('run-empty'));
    writeFileSync(
      path.join(presentRuns, 'run-empty', 'heartbeat.jsonl'),
      '',
      'utf-8'
    );

    writeRunState(presentRuns, 'run-blank', unfinishedState('run-blank'));
    writeFileSync(
      path.join(presentRuns, 'run-blank', 'heartbeat.jsonl'),
      '\n\n',
      'utf-8'
    );

    writeRunState(presentRuns, 'run-no-hb', unfinishedState('run-no-hb'));

    const { service, killForRun, store } = build(workspace, presentRuns);
    const result = await service.tick(workspace);
    expect(killForRun).not.toHaveBeenCalled();
    expect(result.killed).toEqual([]);
    expect(result.skipped).toEqual(
      expect.arrayContaining([
        { runId: 'run-bad', reason: 'heartbeat-unreadable' },
        { runId: 'run-empty', reason: 'heartbeat-unreadable' },
        { runId: 'run-blank', reason: 'heartbeat-unreadable' }
      ])
    );
    expect(result.skipped.some(s => s.runId === 'run-no-hb')).toBe(false);
    expect(store.listPendingWakes(workspace)).toHaveLength(0);
  });

  it('falls back to mtime episode ids and honors CURSOR_AGENT_BIN / empty stall env', async () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), 'stale-episode-'));
    const runsDir = path.join(workspace, 'runs');
    writeDaemonConfig(workspace, runsDir);
    process.env.SDLC_AGENT_STALL_SECONDS = '';
    process.env.CURSOR_AGENT_BIN = 'my-agent';

    writeRunState(runsDir, 'run-no-ts', unfinishedState('run-no-ts'));
    writeHeartbeat(
      runsDir,
      'run-no-ts',
      {
        runId: 'run-no-ts',
        step: 'implementation',
        agentAlive: true
      },
      DEFAULT_AGENT_STALL_SECONDS + 10
    );

    const { service, store, killForRun } = build(workspace, runsDir);
    const result = await service.tick(workspace);
    expect(result.killed).toEqual(['run-no-ts']);
    expect(killForRun).toHaveBeenCalledTimes(1);
    const stalled = store
      .listPendingWakes(workspace)
      .filter(wake => wake.signal.startsWith('agent-stalled:run-no-ts:mtime:'));
    expect(stalled).toHaveLength(1);

    // Default killer scopes to binary + runId and tolerates no matches.
    expect(() =>
      killAgentsForRun({ runId: 'run-no-ts', runsDir })
    ).not.toThrow();
  });

  it('is invoked from ContinuityService.tick when wired', async () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), 'stale-wired-'));
    const runsDir = path.join(workspace, 'runs');
    writeDaemonConfig(workspace, runsDir);
    const staleTick = jest.fn().mockResolvedValue({
      scanned: 0,
      killed: [],
      skipped: []
    });
    const continuity = new ContinuityService(
      {
        load: () => ({
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
        }),
        derivePaths: jest.fn()
      },
      { load: () => null, idleSeconds: () => null } as never,
      { read: jest.fn(), readAtRef: jest.fn() },
      { spawnDetached: jest.fn(), isAlive: jest.fn() },
      new RunLockRepository(),
      new DaemonStoreRepository(),
      { query: jest.fn() },
      { tick: staleTick }
    );
    await continuity.tick(workspace);
    expect(staleTick).toHaveBeenCalledWith(workspace);
  });

  it('treats a directory heartbeat path as unreadable and ignores blank agent bin env', async () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), 'stale-fs-'));
    const runsDir = path.join(workspace, 'runs');
    writeDaemonConfig(workspace, runsDir);
    process.env.CURSOR_AGENT_BIN = '   ';

    writeRunState(runsDir, 'run-dir-hb', unfinishedState('run-dir-hb'));
    mkdirSync(path.join(runsDir, 'run-dir-hb', 'heartbeat.jsonl'), {
      recursive: true
    });

    const { service, killForRun } = build(workspace, runsDir);
    const result = await service.tick(workspace);
    expect(killForRun).not.toHaveBeenCalled();
    expect(result.skipped).toContainEqual({
      runId: 'run-dir-hb',
      reason: 'heartbeat-unreadable'
    });

    expect(() =>
      killAgentsForRun({ runId: 'run-dir-hb', runsDir })
    ).not.toThrow();
  });
});
