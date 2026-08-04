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
import {
  SuperviseExitRepository,
  type ISuperviseExitRepository
} from '../repositories/supervise-exit.repository';
import {
  WakeInboxRepository,
  type IWakeInboxRepository
} from '../repositories/wake-inbox.repository';
import { WORKFLOW_TOKENS } from '../tokens';
import type { RunState, SpecDocument } from '../types';
import {
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  existsSync,
  readFileSync,
  readdirSync
} from 'fs';
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
  let note: jest.Mock;
  let supervise: ISuperviseService;
  let runsDir: string;
  let wakeDir: string;
  let exitRepo: ISuperviseExitRepository;

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
    wakeDir = mkdtempSync(path.join(os.tmpdir(), 'sdlc-wake-'));
    runTask = jest.fn();
    load = jest.fn().mockReturnValue(null);
    read = jest.fn().mockReturnValue(baseSpec);
    spawnDetached = jest.fn().mockReturnValue({ pid: 4242 });
    isAlive = jest.fn().mockReturnValue(true);
    note = jest.fn();
    exitRepo = new SuperviseExitRepository();

    const container = new Container();
    container
      .bind<IRunHandler>(WORKFLOW_TOKENS.RunHandler)
      .toConstantValue({ runTask } as unknown as IRunHandler);
    container
      .bind<ISpecDocRepository>(WORKFLOW_TOKENS.SpecDocRepository)
      .toConstantValue({
        read,
        readAtRef: jest.fn().mockReturnValue(baseSpec)
      } as unknown as ISpecDocRepository);
    container.bind(WORKFLOW_TOKENS.GitRepository).toConstantValue({
      fetch: jest.fn(),
      defaultBranch: jest.fn().mockReturnValue('main'),
      fileAtRef: jest.fn(),
      pathDiffersFromRef: jest.fn(),
      headSha: jest.fn(),
      status: jest.fn(),
      addWorktree: jest.fn(),
      diffStat: jest.fn(),
      diffText: jest.fn(),
      push: jest.fn(),
      resolveSha: jest.fn(),
      revertMerge: jest.fn(),
      stageAll: jest.fn(),
      commit: jest.fn(),
      removeWorktreeAsync: jest.fn()
    });
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
        note
      });
    container
      .bind<ISuperviseExitRepository>(WORKFLOW_TOKENS.SuperviseExitRepository)
      .toConstantValue(exitRepo);
    container
      .bind<IWakeInboxRepository>(WORKFLOW_TOKENS.WakeInboxRepository)
      .to(WakeInboxRepository);
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
    wakeDir,
    ...over
  });

  const pendingWakes = (): string[] => {
    const pending = path.join(wakeDir, 'pending');
    if (!existsSync(pending)) {
      return [];
    }
    return readdirSync(pending).filter(name => name.endsWith('.json'));
  };

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

  // A child that dies on startup (bad spec path, spec still Draft, repo not a
  // worktree) used to leave the parent printing "detached" and exiting 0, so
  // the operator walked away from a run that never began. The detached launch
  // must not claim success it cannot see.
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

  it('clears supervise.pid on clean exit so intake refusal is not relaunched (#37)', async () => {
    runTask.mockResolvedValueOnce(wave('blocked'));

    await supervise.run(input());

    const pidPath = path.join(runsDir, 'run-1', 'supervise.pid');
    expect(existsSync(pidPath)).toBe(false);
  });

  it('leaves supervise.pid in place on a crash so the daemon can relaunch (#37)', async () => {
    runTask.mockRejectedValueOnce(new Error('boom mid-wave'));

    await expect(supervise.run(input())).rejects.toThrow('boom mid-wave');

    const pidPath = path.join(runsDir, 'run-1', 'supervise.pid');
    expect(existsSync(pidPath)).toBe(true);
  });

  it('writes supervise.exit + monitor line + wake when the loop throws after wave 1 (#38)', async () => {
    runTask
      .mockResolvedValueOnce(wave('executed'))
      .mockRejectedValueOnce(new Error('boom after wave 1'));

    load.mockReturnValueOnce({
      taskResults: {
        'T-01': {
          taskId: 'T-01',
          status: 'completed',
          mergedSha: 'a',
          recordedAt: 't'
        }
      }
    } as unknown as RunState);

    await expect(supervise.run(input())).rejects.toThrow('boom after wave 1');

    const runDir = path.join(runsDir, 'run-1');
    const exit = exitRepo.read(runDir);
    expect(exit).not.toBeNull();
    expect(exit?.code).not.toBe(0);
    expect(exit?.reason).toContain('boom after wave 1');
    expect(exit?.abnormal).toBe(true);

    const exitNotes = note.mock.calls
      .map(call => String(call[1]))
      .filter(line => line.includes('[supervise] exit'));
    expect(exitNotes.length).toBeGreaterThanOrEqual(1);
    expect(exitNotes[exitNotes.length - 1]).toContain('abnormal=true');

    const wakes = pendingWakes();
    expect(wakes.length).toBe(1);
    const wake = JSON.parse(
      readFileSync(path.join(wakeDir, 'pending', wakes[0]), 'utf-8')
    ) as { kind: string; data: { code: number; reason: string } };
    expect(wake.kind).toBe('sdlc_supervisor');
    expect(wake.data.code).not.toBe(0);
    expect(wake.data.reason).toContain('boom after wave 1');
  });

  it('distinguishes clean all-merged exit 0 from abnormal incomplete zero-exit (#38)', async () => {
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

    const clean = await supervise.run(input({ runId: 'clean-run' }));
    expect(clean.kind).toBe('completed');
    const cleanExit = exitRepo.read(path.join(runsDir, 'clean-run'));
    expect(cleanExit).toEqual(
      expect.objectContaining({
        code: 0,
        reason: 'all-tasks-merged',
        abnormal: false
      })
    );

    runTask.mockResolvedValue(wave('no-ready-task'));
    load.mockReturnValue({ taskResults: {} } as unknown as RunState);

    const incomplete = await supervise.run(input({ runId: 'incomplete-run' }));
    expect(incomplete.kind).toBe('stopped');
    const abnormalExit = exitRepo.read(path.join(runsDir, 'incomplete-run'));
    expect(abnormalExit).toEqual(
      expect.objectContaining({
        code: 0,
        reason: 'no-ready-task',
        abnormal: true
      })
    );

    expect(cleanExit?.abnormal).not.toBe(abnormalExit?.abnormal);
    expect(cleanExit?.reason).not.toBe(abnormalExit?.reason);
  });

  it('propagates failed (non-zero) when detach child dies for a missing spec (#38)', async () => {
    isAlive.mockReturnValue(false);
    const logPath = path.join(runsDir, 'run-1', 'supervise.log');
    mkdirSync(path.dirname(logPath), { recursive: true });
    writeFileSync(logPath, '✗ SPEC_MALFORMED: Spec file not found: /nope.md\n');

    const result = await supervise.run(
      input({
        detach: true,
        supervise: true,
        detachArgv: [
          'node',
          'src/index.ts',
          'run',
          '--spec',
          '/nope.md',
          '--repo',
          '/r',
          '--detach'
        ]
      })
    );

    expect(result.kind).toBe('failed');
    expect(result.detail).toContain('Spec file not found');
  });

  it('reports detach startup failure even when the child left an empty log', async () => {
    isAlive.mockReturnValue(false);
    // No supervise.log — tailFile returns '' and the parent still fails loud.

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

    expect(result.kind).toBe('failed');
    expect(result.detail).toBe('');
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
