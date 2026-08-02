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
import { mkdtempSync } from 'fs';
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
      .toConstantValue({ spawnDetached });
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
