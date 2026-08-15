import 'reflect-metadata';
import { mkdtempSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import { Container } from 'inversify';
import { DropStateRepository } from '../repositories/drop-state.repository';
import type { IGitRepository } from '../repositories/git.repository';
import type { IPullRequestRepository } from '../repositories/pull-request.repository';
import { DropService, IDropService } from '../services/drop.service';
import { WORKFLOW_TOKENS } from '../tokens';
import { DropInput, WorkflowError } from '../types';

const baseInput = (dropsDir: string): DropInput => ({
  dropId: '2026-08-15',
  issues: ['Rosetta-Foundation/rosetta_docs#57'],
  repoPath: '/repo',
  dropsDir,
  baseRef: 'origin/main',
  mode: 'direct',
  requireApprove: false
});

describe('DropService', () => {
  let dropsDir: string;
  let service: IDropService;
  let addWorktree: jest.Mock;
  let resolveSha: jest.Mock;
  let push: jest.Mock;
  let findByBranch: jest.Mock;
  let create: jest.Mock;
  let merge: jest.Mock;

  beforeEach(() => {
    dropsDir = mkdtempSync(path.join(os.tmpdir(), 'sdlc-drop-'));
    addWorktree = jest.fn();
    resolveSha = jest.fn().mockReturnValue('base-sha');
    push = jest.fn();
    findByBranch = jest.fn().mockReturnValue(null);
    create = jest.fn().mockReturnValue({
      url: 'https://github.com/org/repo/pull/9',
      number: 9
    });
    merge = jest.fn().mockReturnValue('merge-sha');

    const container = new Container();
    container
      .bind<IGitRepository>(WORKFLOW_TOKENS.GitRepository)
      .toConstantValue({
        addWorktree,
        resolveSha,
        push,
        diffStat: jest.fn(),
        diffText: jest.fn(),
        headSha: jest.fn(),
        status: jest.fn(),
        fetch: jest.fn(),
        treeSha: jest.fn(),
        worktreeForBranch: jest.fn(),
        refExists: jest.fn(),
        defaultBranch: jest.fn(),
        fileAtRef: jest.fn(),
        pathDiffersFromRef: jest.fn(),
        revertMerge: jest.fn(),
        stageAll: jest.fn(),
        commit: jest.fn(),
        listFiles: jest.fn(),
        removeWorktreeAsync: jest.fn()
      });
    container
      .bind<IPullRequestRepository>(WORKFLOW_TOKENS.PullRequestRepository)
      .toConstantValue({
        findByBranch,
        latestForBranch: jest.fn(),
        create,
        merge,
        mergeCommitOid: jest.fn(),
        comment: jest.fn(),
        updateBody: jest.fn()
      });
    container
      .bind(WORKFLOW_TOKENS.DropStateRepository)
      .to(DropStateRepository);
    container.bind<IDropService>(WORKFLOW_TOKENS.DropService).to(DropService);
    service = container.get<IDropService>(WORKFLOW_TOKENS.DropService);
  });

  afterEach(() => {
    rmSync(dropsDir, { recursive: true, force: true });
  });

  it('arms two drops from the same tip into distinct worktrees', () => {
    const first = service.arm(baseInput(dropsDir));
    const second = service.arm({
      ...baseInput(dropsDir),
      dropId: '2026-08-15-b'
    });

    expect(first.worktreePath).not.toBe(second.worktreePath);
    expect(first.baseSha).toBe('base-sha');
    expect(second.baseSha).toBe('base-sha');
    expect(addWorktree).toHaveBeenCalledTimes(2);
    expect(addWorktree.mock.calls[0][1]).toBe(first.worktreePath);
    expect(addWorktree.mock.calls[1][1]).toBe(second.worktreePath);
  });

  it('reuses an already-armed drop instead of creating a second worktree', () => {
    service.arm(baseInput(dropsDir));
    service.arm(baseInput(dropsDir));
    expect(addWorktree).toHaveBeenCalledTimes(1);
  });

  it('opens one PR for the drop and reuses it on finish', () => {
    service.arm(baseInput(dropsDir));
    const opened = service.openPr(dropsDir, '2026-08-15', [
      { id: 'T-01', title: 'envelope', done: true }
    ]);
    expect(opened.prNumber).toBe(9);
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][1].body).toContain(
      '- [x] T-01: envelope'
    );

    findByBranch.mockReturnValue({
      url: 'https://github.com/org/repo/pull/9',
      number: 9
    });
    service.openPr(dropsDir, '2026-08-15');
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('merges a direct drop on machine gates', () => {
    service.arm(baseInput(dropsDir));
    service.openPr(dropsDir, '2026-08-15');
    const merged = service.mergeDirect(dropsDir, '2026-08-15');
    expect(merged.mergedSha).toBe('merge-sha');
    expect(merge).toHaveBeenCalledWith(expect.any(String), 9);
  });

  it('fails loud when branch protection still requires a person', () => {
    merge.mockImplementation(() => {
      throw new WorkflowError('gh merge failed', 'GH_FAILED', [
        'At least 1 approving review is required to merge'
      ]);
    });
    service.arm(baseInput(dropsDir));
    service.openPr(dropsDir, '2026-08-15');
    expect(() => service.mergeDirect(dropsDir, '2026-08-15')).toThrow(
      /branch protection still requires a human review/
    );
  });

  it('does not machine-merge a non-direct drop', () => {
    service.arm({ ...baseInput(dropsDir), mode: 'bug-spec' });
    service.openPr(dropsDir, '2026-08-15');
    expect(() => service.mergeDirect(dropsDir, '2026-08-15')).toThrow(
      /direct drops only/
    );
  });

  it('refuses an empty issue list and --require-approve merge', () => {
    expect(() =>
      service.arm({ ...baseInput(dropsDir), issues: [] })
    ).toThrow(/at least one issue ref/);
    service.arm({ ...baseInput(dropsDir), requireApprove: true });
    service.openPr(dropsDir, '2026-08-15');
    expect(() => service.mergeDirect(dropsDir, '2026-08-15')).toThrow(
      /require-approve/
    );
  });

  it('refuses merge without a PR and is idempotent after a merge SHA', () => {
    service.arm(baseInput(dropsDir));
    expect(() => service.mergeDirect(dropsDir, '2026-08-15')).toThrow(
      /no PR to merge/
    );
    service.openPr(dropsDir, '2026-08-15');
    const first = service.mergeDirect(dropsDir, '2026-08-15');
    const second = service.mergeDirect(dropsDir, '2026-08-15');
    expect(second.mergedSha).toBe(first.mergedSha);
    expect(merge).toHaveBeenCalledTimes(1);
  });

  it('stores an optional envelope and uses the default task checkbox line', () => {
    const withEnvelope = service.arm({
      ...baseInput(dropsDir),
      envelope: {
        allowedPaths: ['src/**'],
        forbiddenSurfaces: [],
        maxDiffLines: 80,
        budgetK: 100
      }
    });
    expect(withEnvelope.envelope?.maxDiffLines).toBe(80);
    service.openPr(dropsDir, '2026-08-15');
    expect(create.mock.calls[0][1].body).toContain(
      'commits on this branch are the drop tasks'
    );
  });

  it('rethrows a merge failure that is not a human-review block', () => {
    merge.mockImplementation(() => {
      throw new WorkflowError('gh merge failed', 'GH_FAILED', [
        'merge conflict in src/a.ts'
      ]);
    });
    service.arm(baseInput(dropsDir));
    service.openPr(dropsDir, '2026-08-15');
    expect(() => service.mergeDirect(dropsDir, '2026-08-15')).toThrow(
      /gh merge failed/
    );
  });

  it('rethrows a non-DROP_INVALID load error from tryLoad', () => {
    const container = new Container();
    container
      .bind<IGitRepository>(WORKFLOW_TOKENS.GitRepository)
      .toConstantValue({
        addWorktree,
        resolveSha,
        push,
        diffStat: jest.fn(),
        diffText: jest.fn(),
        headSha: jest.fn(),
        status: jest.fn(),
        fetch: jest.fn(),
        treeSha: jest.fn(),
        worktreeForBranch: jest.fn(),
        refExists: jest.fn(),
        defaultBranch: jest.fn(),
        fileAtRef: jest.fn(),
        pathDiffersFromRef: jest.fn(),
        revertMerge: jest.fn(),
        stageAll: jest.fn(),
        commit: jest.fn(),
        listFiles: jest.fn(),
        removeWorktreeAsync: jest.fn()
      });
    container
      .bind<IPullRequestRepository>(WORKFLOW_TOKENS.PullRequestRepository)
      .toConstantValue({
        findByBranch,
        latestForBranch: jest.fn(),
        create,
        merge,
        mergeCommitOid: jest.fn(),
        comment: jest.fn(),
        updateBody: jest.fn()
      });
    container.bind(WORKFLOW_TOKENS.DropStateRepository).toConstantValue({
      write: jest.fn(),
      load: jest.fn(() => {
        throw new WorkflowError('disk exploded', 'GIT_FAILED');
      }),
      pathFor: jest.fn()
    });
    container.bind<IDropService>(WORKFLOW_TOKENS.DropService).to(DropService);
    const exploding = container.get<IDropService>(WORKFLOW_TOKENS.DropService);
    expect(() => exploding.arm(baseInput(dropsDir))).toThrow(/disk exploded/);
  });

  it('stringifies a non-WorkflowError merge throw', () => {
    merge.mockImplementation(() => {
      throw new Error('review required by CODEOWNERS');
    });
    service.arm(baseInput(dropsDir));
    service.openPr(dropsDir, '2026-08-15');
    expect(() => service.mergeDirect(dropsDir, '2026-08-15')).toThrow(
      /branch protection still requires a human review/
    );
  });
});
