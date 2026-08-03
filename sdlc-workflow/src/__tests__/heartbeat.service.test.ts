import 'reflect-metadata';
import { Container } from 'inversify';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { IGitRepository } from '../repositories/git.repository';
import {
  HeartbeatService,
  IHeartbeatService
} from '../services/heartbeat.service';
import { WORKFLOW_TOKENS } from '../tokens';

describe('HeartbeatService (#39)', () => {
  let service: IHeartbeatService;
  let runsDir: string;
  let status: jest.Mock;
  let headSha: jest.Mock;
  let logSpy: jest.SpyInstance;

  beforeEach(() => {
    runsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-hb-'));
    status = jest.fn().mockReturnValue(' M src/a.ts\n');
    headSha = jest.fn().mockReturnValue('abcdef1234567890');
    const container = new Container();
    container
      .bind<IGitRepository>(WORKFLOW_TOKENS.GitRepository)
      .toConstantValue({
        headSha,
        status,
        addWorktree: jest.fn(),
        diffStat: jest.fn(),
        diffText: jest.fn(),
        push: jest.fn(),
        fetch: jest.fn(),
        resolveSha: jest.fn(),
        defaultBranch: jest.fn(),
        fileAtRef: jest.fn(),
        pathDiffersFromRef: jest.fn(),
        revertMerge: jest.fn(),
        stageAll: jest.fn(),
        commit: jest.fn(),
        removeWorktreeAsync: jest.fn()
      });
    container
      .bind<IHeartbeatService>(WORKFLOW_TOKENS.HeartbeatService)
      .to(HeartbeatService);
    service = container.get<IHeartbeatService>(
      WORKFLOW_TOKENS.HeartbeatService
    );
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    service.stop();
    logSpy.mockRestore();
    fs.rmSync(runsDir, { recursive: true, force: true });
  });

  it('emits a structured line and appends heartbeat.jsonl on tick', () => {
    service.start({ runId: 'run-1', runsDir, intervalMs: 60_000 });
    service.setContext({
      taskId: 'T-04',
      step: 'implementation',
      worktreePath: '/wt/T-04',
      lastLine: 'dispatching implementation agent'
    });
    service.tick();

    const hbLines = logSpy.mock.calls
      .map(call => String(call[0]))
      .filter(line => line.startsWith('[heartbeat] '));
    expect(hbLines.length).toBeGreaterThanOrEqual(1);
    const payload = JSON.parse(
      hbLines[hbLines.length - 1].replace('[heartbeat] ', '')
    );
    expect(payload).toEqual(
      expect.objectContaining({
        runId: 'run-1',
        taskId: 'T-04',
        step: 'implementation',
        worktreeDirty: true,
        worktreeHead: 'abcdef123456',
        lastLine: 'dispatching implementation agent'
      })
    );
    expect(typeof payload.agentAlive).toBe('boolean');
    expect(typeof payload.stepElapsedMs).toBe('number');

    const jsonl = fs.readFileSync(
      path.join(runsDir, 'run-1', 'heartbeat.jsonl'),
      'utf-8'
    );
    expect(jsonl.trim().split('\n').length).toBeGreaterThanOrEqual(1);
  });

  it('does not start a timer when intervalMs is 0', () => {
    service.start({ runId: 'run-1', runsDir, intervalMs: 0 });
    // No identity recorded → tick is a no-op.
    service.tick();
    const hbCalls = logSpy.mock.calls.filter(call =>
      String(call[0]).startsWith('[heartbeat]')
    );
    expect(hbCalls).toHaveLength(0);
  });

  it('keeps stepElapsed when setContext does not change the step name', () => {
    jest.useFakeTimers();
    service.start({ runId: 'run-1', runsDir, intervalMs: 60_000 });
    service.setContext({ step: 'implementation', taskId: 'T-01' });
    jest.advanceTimersByTime(5_000);
    service.setContext({ lastLine: 'still implementing' });
    service.tick();
    const hbLines = logSpy.mock.calls
      .map(call => String(call[0]))
      .filter(line => line.startsWith('[heartbeat] '));
    const payload = JSON.parse(
      hbLines[hbLines.length - 1].replace('[heartbeat] ', '')
    );
    expect(payload.step).toBe('implementation');
    expect(payload.stepElapsedMs).toBeGreaterThanOrEqual(5_000);
    expect(payload.lastLine).toBe('still implementing');
    jest.useRealTimers();
  });
});
