import 'reflect-metadata';
import { Container } from 'inversify';
import {
  ISuperviseService,
  SuperviseService
} from '../services/supervise.service';
import type { IRunHandler, RunTaskResult } from '../handlers/run.handler';
import type { ISpecDocRepository } from '../repositories/spec-doc.repository';
import type { IRunStateRepository } from '../repositories/run-state.repository';
import type { IProcessDetachRepository } from '../repositories/process-detach.repository';
import type { IHeartbeatWatchService } from '../services/heartbeat-watch.service';
import { WORKFLOW_TOKENS } from '../tokens';
import type { RunState, SpecDocument } from '../types';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';

const wave = (
  outcome: RunTaskResult['outcome'],
  kind: 'completed' | 'failed' = 'completed'
): RunTaskResult => ({
  outcome,
  tasks: [{ taskId: 'T-01', kind, branch: 'b' }]
});

describe('SuperviseService', () => {
  let runTask: jest.Mock;
  let load: jest.Mock;
  let read: jest.Mock;
  let spawnDetached: jest.Mock;
  let isAlive: jest.Mock;
  let supervise: ISuperviseService;
  let runsDir: string;

  const baseSpec: SpecDocument = {
    id: 'SPEC-X',
    prdId: 'PRD-X',
    phase: 0,
    status: 'Approved',
    envelope: {
      allowedPaths: ['a/**'],
      forbiddenSurfaces: [],
      maxDiffLines: 10,
      budgetK: 1
    },
    tasks: [
      {
        id: 'T-01',
        storyId: 'S-01',
        phase: 0,
        title: 'one',
        engineeringNotes: 'n',
        complexity: 'S',
        dependsOn: [],
        acceptanceCriteria: ['test: x']
      },
      {
        id: 'T-02',
        storyId: 'S-01',
        phase: 0,
        title: 'two',
        engineeringNotes: 'n',
        complexity: 'S',
        dependsOn: ['T-01'],
        acceptanceCriteria: ['test: x']
      }
    ]
  };

  beforeEach(() => {
    runsDir = mkdtempSync(path.join(os.tmpdir(), 'sdlc-sup-'));
    runTask = jest.fn();
    load = jest.fn().mockReturnValue(null);
    read = jest.fn().mockReturnValue(baseSpec);
    spawnDetached = jest.fn().mockReturnValue({ pid: 4242 });
    isAlive = jest.fn().mockReturnValue(true);

    const container = new Container();
    container
      .bind<IRunHandler>(WORKFLOW_TOKENS.RunHandler)
      .toConstantValue({ runTask } as unknown as IRunHandler);
    container
      .bind<ISpecDocRepository>(WORKFLOW_TOKENS.SpecDocRepository)
      .toConstantValue({ read } as unknown as ISpecDocRepository);
    container
      .bind<IRunStateRepository>(WORKFLOW_TOKENS.RunStateRepository)
      .toConstantValue({ load } as unknown as IRunStateRepository);
    container
      .bind<IProcessDetachRepository>(WORKFLOW_TOKENS.ProcessDetachRepository)
      .toConstantValue({ spawnDetached, isAlive });
    container
      .bind<IHeartbeatWatchService>(WORKFLOW_TOKENS.HeartbeatWatchService)
      .toConstantValue({
        start: jest.fn(),
        stop: jest.fn(),
        note: jest.fn()
      });
    container
      .bind<ISuperviseService>(WORKFLOW_TOKENS.SuperviseService)
      .to(SuperviseService);
    supervise = container.get(WORKFLOW_TOKENS.SuperviseService);
  });

  const input = (
    over: Partial<Parameters<ISuperviseService['run']>[0]> = {}
  ) => ({
    specPath: '/spec.md',
    repoPath: '/repo',
    runId: 'run-1',
    runsDir,
    maxParallel: 1,
    supervise: true,
    detach: false,
    ...over
  });

  it('detach spawns a child and returns without running waves', async () => {
    const result = await supervise.run(
      input({
        detach: true,
        supervise: true,
        detachArgv: [
          'node',
          'src/index.ts',
          'run',
          '--spec',
          '/s.md',
          '--repo',
          '/r',
          '--detach'
        ]
      })
    );
    expect(result.kind).toBe('detached');
    expect(result.pid).toBe(4242);
    expect(spawnDetached).toHaveBeenCalled();
    expect(runTask).not.toHaveBeenCalled();
    const spawnArgs = spawnDetached.mock.calls[0][0].args as string[];
    expect(spawnArgs).toContain('--supervise');
    expect(spawnArgs).not.toContain('--detach');
  });

  // Running from source, execPath is plain node and the entry is a .ts file,
  // so dropping the interpreter flags detaches into a guaranteed
  // ERR_UNKNOWN_FILE_EXTENSION. The same flags go into launch.json, or the
  // continuity daemon's relaunch inherits the identical crash.
  it('replays the interpreter flags into the child and the launch record', async () => {
    const original = process.execArgv;
    process.execArgv = ['--import', 'tsx/loader.mjs'];

    try {
      await supervise.run({
        specPath: '/s.md',
        repoPath: '/r',
        runsDir,
        runId: 'run-exec-argv',
        maxParallel: 1,
        supervise: true,
        detach: true,
        detachArgv: ['node', 'index.ts', 'run', '--detach']
      });

      const spawnArgs = spawnDetached.mock.calls[0][0].args as string[];
      expect(spawnArgs.slice(0, 2)).toEqual(['--import', 'tsx/loader.mjs']);

      const record = JSON.parse(
        readFileSync(path.join(runsDir, 'run-exec-argv', 'launch.json'), 'utf-8')
      ) as { execArgv: string[] };
      expect(record.execArgv).toEqual(['--import', 'tsx/loader.mjs']);
    } finally {
      process.execArgv = original;
    }
  });

  // A child that dies on startup (bad spec path, spec still Draft, repo not a
  // worktree) used to leave the parent printing "detached" and exiting 0. The
  // operator walks away from a run that never began, and no state.json is
  // written so the continuity daemon skips the directory too — nothing at all
  // reports it. The detached launch must not claim success it cannot see.
  it('reports failure when the detached child dies during startup', async () => {
    isAlive.mockReturnValue(false);
    const logPath = path.join(runsDir, 'run-1', 'supervise.log');
    mkdirSync(path.dirname(logPath), { recursive: true });
    writeFileSync(
      logPath,
      '\nRun run-1 — /spec.md\n\n✗ SPEC_MALFORMED: Spec file not found: /spec.md\n'
    );

    const result = await supervise.run(
      input({
        detachArgv: [
          'node',
          'src/index.ts',
          'run',
          '--spec',
          '/s.md',
          '--repo',
          '/r',
          '--detach'
        ],
        detach: true,
        supervise: true
      })
    );

    expect(result.kind).toBe('failed');
    expect(result.pid).toBe(4242);
    // The child's own error is what the operator needs, not "it died".
    expect(result.detail).toContain('SPEC_MALFORMED');
    expect(isAlive).toHaveBeenCalledWith(4242);
  });

  it('does not claim failure when the child is still alive', async () => {
    isAlive.mockReturnValue(true);

    const result = await supervise.run(
      input({
        detachArgv: [
          'node',
          'src/index.ts',
          'run',
          '--spec',
          '/s.md',
          '--repo',
          '/r',
          '--detach'
        ],
        detach: true,
        supervise: true
      })
    );

    expect(result.kind).toBe('detached');
    expect(result.detail).toBeUndefined();
  });

  it('loops until all tasks are merged', async () => {
    runTask
      .mockResolvedValueOnce(wave('executed'))
      .mockResolvedValueOnce(wave('executed'));

    const mergedBoth = {
      taskResults: {
        'T-01': {
          taskId: 'T-01',
          status: 'completed',
          mergedSha: 'a',
          recordedAt: 't'
        },
        'T-02': {
          taskId: 'T-02',
          status: 'completed',
          mergedSha: 'b',
          recordedAt: 't'
        }
      }
    } as unknown as RunState;

    load
      .mockReturnValueOnce({
        taskResults: {
          'T-01': {
            taskId: 'T-01',
            status: 'completed',
            mergedSha: 'a',
            recordedAt: 't'
          }
        }
      } as unknown as RunState)
      .mockReturnValueOnce(mergedBoth);

    const result = await supervise.run(input());
    expect(result.kind).toBe('completed');
    expect(result.waves).toBe(2);
    expect(runTask).toHaveBeenCalledTimes(2);
  });

  it('stops at shadow human gate when tasks are completed but unmerged', async () => {
    runTask.mockResolvedValue(wave('executed'));
    load.mockReturnValue({
      taskResults: {
        'T-01': {
          taskId: 'T-01',
          status: 'completed',
          recordedAt: 't'
        }
      }
    } as unknown as RunState);

    const result = await supervise.run(input({ shadow: true }));
    expect(result.kind).toBe('stopped');
    expect(result.detail).toBe('shadow-human-gate');
    expect(runTask).toHaveBeenCalledTimes(1);
  });

  it('runs a single wave when supervise is false', async () => {
    runTask.mockResolvedValue(wave('executed'));
    load.mockReturnValue({
      taskResults: {
        'T-01': {
          taskId: 'T-01',
          status: 'completed',
          mergedSha: 'a',
          recordedAt: 't'
        },
        'T-02': {
          taskId: 'T-02',
          status: 'completed',
          mergedSha: 'b',
          recordedAt: 't'
        }
      }
    } as unknown as RunState);

    const result = await supervise.run(input({ supervise: false }));
    expect(result.kind).toBe('completed');
    expect(result.waves).toBe(1);
    expect(runTask).toHaveBeenCalledTimes(1);
  });

  it('maps blocked / failed single-wave outcomes to failed', async () => {
    runTask.mockResolvedValueOnce(wave('blocked'));
    expect((await supervise.run(input({ supervise: false }))).kind).toBe(
      'failed'
    );

    runTask.mockResolvedValueOnce(wave('executed', 'failed'));
    expect((await supervise.run(input({ supervise: false }))).kind).toBe(
      'failed'
    );
  });

  it('stops the loop when a wave is blocked or a task fails', async () => {
    runTask.mockResolvedValueOnce(wave('blocked'));
    const blocked = await supervise.run(input());
    expect(blocked.kind).toBe('failed');
    expect(blocked.detail).toBe('blocked');

    runTask.mockResolvedValueOnce(wave('executed', 'failed'));
    const failed = await supervise.run(input());
    expect(failed.kind).toBe('failed');
    expect(failed.detail).toBe('task-failed');
  });

  it('stops when no ready task remains and work is incomplete', async () => {
    runTask.mockResolvedValue(wave('no-ready-task'));
    load.mockReturnValue({ taskResults: {} } as unknown as RunState);

    const result = await supervise.run(input());
    expect(result.kind).toBe('stopped');
    expect(result.detail).toBe('no-ready-task');
  });

  it('fails immediately on enforce merge-blocked instead of spinning no-ready', async () => {
    runTask.mockResolvedValue(wave('executed'));
    load.mockReturnValue({
      taskResults: {
        'T-01': {
          taskId: 'T-01',
          status: 'completed',
          recordedAt: 't'
        }
      },
      steps: {
        'phase:T-01': {
          name: 'phase',
          taskId: 'T-01',
          inputsDigest: 'x',
          verdict: {
            gate: 'phase',
            outcome: 'breach',
            wouldEscalate: true,
            reasons: ['failing gates: envelope'],
            recordedAt: 't'
          },
          completedAt: 't'
        }
      },
      exceptions: [
        {
          trigger: 'merge-blocked',
          taskId: 'T-01',
          context: ['failing gates: envelope'],
          recordedAt: 't'
        }
      ]
    } as unknown as RunState);

    const result = await supervise.run(input());
    expect(result.kind).toBe('failed');
    expect(result.detail).toBe('merge-blocked');
    expect(runTask).toHaveBeenCalledTimes(1);
  });

  it('fails when max-waves is exhausted without full merge', async () => {
    runTask.mockResolvedValue(wave('executed'));
    load.mockReturnValue({
      taskResults: {
        'T-01': {
          taskId: 'T-01',
          status: 'completed',
          mergedSha: 'a',
          recordedAt: 't'
        }
      }
    } as unknown as RunState);

    const result = await supervise.run(input({ maxWaves: 2 }));
    expect(result.kind).toBe('failed');
    expect(result.detail).toBe('max-waves-2');
    expect(result.waves).toBe(2);
  });

  it('maps incomplete single-wave success to stopped', async () => {
    runTask.mockResolvedValue(wave('executed'));
    load.mockReturnValue({ taskResults: {} } as unknown as RunState);

    const result = await supervise.run(input({ supervise: false }));
    expect(result.kind).toBe('stopped');
  });
});
