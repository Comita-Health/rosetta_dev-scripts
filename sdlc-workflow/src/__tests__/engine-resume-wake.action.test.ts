import { mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { EngineResumeWakeAction } from '../services/engine-resume-wake.action';
import type { WakeEvent } from '../types';
import { writeSuperviseLaunchRecord } from '../utils/launch-record';

const wake = (
  overrides: Partial<WakeEvent> & { data: Record<string, unknown> }
): WakeEvent => ({
  id: 'wake-1',
  kind: 'issue-state',
  target: 'issue-state:owner/repo#1',
  signal: 'closed:1',
  createdAt: '2026-08-09T12:00:00.000Z',
  ...overrides
});

describe('EngineResumeWakeAction', () => {
  it('no-ops when the wake is not a resume signal', async () => {
    const action = new EngineResumeWakeAction(
      { load: jest.fn(), derivePaths: jest.fn() },
      { load: jest.fn() } as never,
      { recordMerge: jest.fn() } as never,
      { spawnDetached: jest.fn(), isAlive: jest.fn() }
    );
    const result = await action.execute({
      workspaceRoot: '/ws',
      consumedBy: 'daemon',
      wake: wake({
        signal: 'approved:1',
        data: { signal: 'approved', runId: 'run-1' }
      })
    });
    expect(result).toEqual({ ok: true });
  });

  it('relaunches from launch.json on closed when supervise is dead', async () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), 'engine-resume-'));
    mkdirSync(path.join(workspace, '.sdlc'), { recursive: true });
    const runsDir = path.join(workspace, 'runs');
    writeFileSync(
      path.join(workspace, '.sdlc', 'daemon.json'),
      JSON.stringify({
        activateScript: path.join(workspace, 'activate.sh'),
        runsDir,
        defaultPollSeconds: 30,
        headlessRunner: 'test'
      })
    );
    writeSuperviseLaunchRecord({
      runsDir,
      runId: 'run-1',
      argv: ['src/index.ts', 'run', '--supervise'],
      execArgv: [],
      execPath: process.execPath,
      cwd: workspace,
      repoPath: '/repo',
      specPath: '/repo/spec.md'
    });

    const spawnDetached = jest.fn().mockReturnValue({ pid: 4242 });
    const action = new EngineResumeWakeAction(
      {
        load: () => ({
          config: {
            workspaceRoot: workspace,
            activateScript: path.join(workspace, 'activate.sh'),
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
      {
        load: jest.fn().mockReturnValue({
          runId: 'run-1',
          taskResults: { 'T-05': {} }
        }),
        recordMergedSha: jest.fn(),
        recordTaskMerged: jest.fn()
      } as never,
      { recordMerge: jest.fn() } as never,
      { spawnDetached, isAlive: jest.fn().mockReturnValue(false) }
    );

    const result = await action.execute({
      workspaceRoot: workspace,
      consumedBy: 'daemon',
      wake: wake({
        data: { signal: 'closed', runId: 'run-1', taskId: 'T-05' }
      })
    });
    expect(result).toEqual({ ok: true });
    expect(spawnDetached).toHaveBeenCalledWith(
      expect.objectContaining({
        command: process.execPath,
        args: ['src/index.ts', 'run', '--supervise'],
        cwd: workspace
      })
    );
  });

  it('records out-of-band merge then relaunches on merged', async () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), 'engine-resume-m-'));
    const runsDir = path.join(workspace, 'runs');
    writeSuperviseLaunchRecord({
      runsDir,
      runId: 'run-1',
      argv: ['entry.js', 'run', '--supervise'],
      execArgv: [],
      execPath: process.execPath,
      cwd: workspace,
      repoPath: '/repo',
      specPath: '/repo/spec.md',
      chronicleRepo: '/chronicle'
    });
    const recordMerge = jest.fn().mockResolvedValue('ok');
    const spawnDetached = jest.fn().mockReturnValue({ pid: 99 });
    const action = new EngineResumeWakeAction(
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
      {
        load: jest.fn().mockReturnValue({
          runId: 'run-1',
          taskResults: { 'T-05': {} }
        })
      } as never,
      { recordMerge } as never,
      { spawnDetached, isAlive: jest.fn().mockReturnValue(false) }
    );

    const result = await action.execute({
      workspaceRoot: workspace,
      consumedBy: 'daemon',
      wake: {
        id: 'w',
        kind: 'pr-review',
        target: 'pr-review:o/r#1',
        signal: 'merged:abc',
        createdAt: '2026-08-09T12:00:00.000Z',
        data: {
          signal: 'merged',
          runId: 'run-1',
          taskId: 'T-05',
          mergeCommitOid: 'abc123',
          chronicleRepo: '/chronicle'
        }
      }
    });
    expect(result).toEqual({ ok: true });
    expect(recordMerge).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'run-1',
        taskId: 'T-05',
        mergedSha: 'abc123',
        approvedBy: 'out-of-band'
      })
    );
    expect(spawnDetached).toHaveBeenCalled();
  });

  it('skips relaunch when supervise pid is still alive', async () => {
    const workspace = mkdtempSync(
      path.join(os.tmpdir(), 'engine-resume-live-')
    );
    const runsDir = path.join(workspace, 'runs');
    mkdirSync(path.join(runsDir, 'run-1'), { recursive: true });
    writeFileSync(path.join(runsDir, 'run-1', 'supervise.pid'), '1234\n');
    const spawnDetached = jest.fn();
    const action = new EngineResumeWakeAction(
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
      { load: jest.fn() } as never,
      { recordMerge: jest.fn() } as never,
      { spawnDetached, isAlive: jest.fn().mockReturnValue(true) }
    );
    const result = await action.execute({
      workspaceRoot: workspace,
      consumedBy: 'daemon',
      wake: wake({ data: { signal: 'closed', runId: 'run-1' } })
    });
    expect(result).toEqual({ ok: true });
    expect(spawnDetached).not.toHaveBeenCalled();
  });
});
