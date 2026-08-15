import 'reflect-metadata';
import { Container } from 'inversify';
import { DropHandler, IDropHandler } from '../handlers/drop.handler';
import type { IDropService } from '../services/drop.service';
import type { IEnvelopeGateService } from '../services/envelope-gate.service';
import { WORKFLOW_TOKENS } from '../tokens';
import { DropInput, DropState, Envelope } from '../types';

const envelope: Envelope = {
  allowedPaths: ['src/**'],
  forbiddenSurfaces: [],
  maxDiffLines: 100,
  budgetK: 200
};

const armed = (overrides: Partial<DropState> = {}): DropState => ({
  dropId: '2026-08-15',
  issues: ['org/repo#1'],
  repoPath: '/repo',
  worktreePath: '/drops/2026-08-15/worktree',
  branch: 'sdlc/drop/2026-08-15',
  baseSha: 'base-sha',
  mode: 'direct',
  requireApprove: false,
  tasks: [],
  updatedAt: 'now',
  ...overrides
});

const input = (overrides: Partial<DropInput> & { finish?: boolean } = {}) => ({
  dropId: '2026-08-15',
  issues: ['org/repo#1'],
  repoPath: '/repo',
  dropsDir: '/drops',
  baseRef: 'HEAD',
  mode: 'direct' as const,
  requireApprove: false,
  finish: false,
  ...overrides
});

describe('DropHandler', () => {
  let handler: IDropHandler;
  let arm: jest.Mock;
  let openPr: jest.Mock;
  let mergeDirect: jest.Mock;
  let evaluate: jest.Mock;

  beforeEach(() => {
    arm = jest.fn().mockReturnValue(armed());
    openPr = jest.fn().mockReturnValue(
      armed({ prUrl: 'https://github.com/org/repo/pull/9', prNumber: 9 })
    );
    mergeDirect = jest.fn().mockReturnValue(
      armed({
        prUrl: 'https://github.com/org/repo/pull/9',
        prNumber: 9,
        mergedSha: 'merge-sha'
      })
    );
    evaluate = jest.fn().mockResolvedValue({
      gate: 'envelope',
      outcome: 'pass',
      wouldEscalate: false,
      reasons: [],
      recordedAt: 'now'
    });

    const container = new Container();
    container.bind<IDropService>(WORKFLOW_TOKENS.DropService).toConstantValue({
      arm,
      openPr,
      mergeDirect
    });
    container
      .bind<IEnvelopeGateService>(WORKFLOW_TOKENS.EnvelopeGateService)
      .toConstantValue({ evaluate });
    container.bind<IDropHandler>(WORKFLOW_TOKENS.DropHandler).to(DropHandler);
    handler = container.get<IDropHandler>(WORKFLOW_TOKENS.DropHandler);
  });

  it('arms and stops when finish is false', async () => {
    const state = await handler.run(input());
    expect(state.worktreePath).toContain('worktree');
    expect(openPr).not.toHaveBeenCalled();
    expect(mergeDirect).not.toHaveBeenCalled();
  });

  it('opens one PR and merges a direct drop on finish', async () => {
    const state = await handler.run(input({ finish: true }));
    expect(openPr).toHaveBeenCalled();
    expect(mergeDirect).toHaveBeenCalled();
    expect(state.mergedSha).toBe('merge-sha');
  });

  it('prints unknown when the opened PR has no URL', async () => {
    openPr.mockReturnValue(armed({ prNumber: 9 }));
    await handler.run(input({ finish: true }));
    expect(openPr).toHaveBeenCalled();
    expect(mergeDirect).toHaveBeenCalled();
  });

  it('evaluates an envelope with no notes and merges on pass', async () => {
    arm.mockReturnValue(armed({ envelope }));
    openPr.mockReturnValue(
      armed({
        envelope,
        prUrl: 'https://github.com/org/repo/pull/9',
        prNumber: 9
      })
    );
    await handler.run(input({ finish: true, envelope }));
    expect(evaluate).toHaveBeenCalled();
    expect(mergeDirect).toHaveBeenCalled();
  });

  it('logs envelope notes and still merges when the gate passes', async () => {
    arm.mockReturnValue(armed({ envelope }));
    openPr.mockReturnValue(
      armed({
        envelope,
        prUrl: 'https://github.com/org/repo/pull/9',
        prNumber: 9
      })
    );
    evaluate.mockResolvedValue({
      gate: 'envelope',
      outcome: 'pass',
      wouldEscalate: false,
      reasons: [],
      notes: ['oversize vs advisory maxDiffLines'],
      recordedAt: 'now'
    });

    await handler.run(input({ finish: true, envelope }));
    expect(evaluate).toHaveBeenCalled();
    expect(mergeDirect).toHaveBeenCalled();
  });

  it('skips merge when the envelope gate breaches', async () => {
    arm.mockReturnValue(armed({ envelope }));
    openPr.mockReturnValue(
      armed({
        envelope,
        prUrl: 'https://github.com/org/repo/pull/9',
        prNumber: 9
      })
    );
    evaluate.mockResolvedValue({
      gate: 'envelope',
      outcome: 'breach',
      wouldEscalate: true,
      reasons: ['outside allowedPaths: infra/x.yml'],
      recordedAt: 'now'
    });

    const state = await handler.run(input({ finish: true, envelope }));
    expect(mergeDirect).not.toHaveBeenCalled();
    expect(state.mergedSha).toBeUndefined();
  });

  it('waits for Approve on a require-approve or non-direct drop', async () => {
    openPr.mockReturnValue(
      armed({
        mode: 'bug-spec',
        requireApprove: true,
        prUrl: 'https://github.com/org/repo/pull/9',
        prNumber: 9
      })
    );
    const state = await handler.run(
      input({ finish: true, mode: 'bug-spec', requireApprove: true })
    );
    expect(mergeDirect).not.toHaveBeenCalled();
    expect(state.mergedSha).toBeUndefined();
  });
});
