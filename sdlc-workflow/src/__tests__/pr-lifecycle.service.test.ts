import 'reflect-metadata';
import { Container } from 'inversify';
import type { IGitRepository } from '../repositories/git.repository';
import type { IPullRequestRepository } from '../repositories/pull-request.repository';
import {
  IPrLifecycleService,
  PrLifecycleService
} from '../services/pr-lifecycle.service';
import { WORKFLOW_TOKENS } from '../tokens';
import { SpecDocument, WorkflowError } from '../types';
import { prBody, prTitle } from '../utils/pr-content';
import { makeEnvelope, makeTask } from './fixtures';

const SPEC: SpecDocument = {
  id: 'SPEC-PRD-0099-P3',
  prdId: 'PRD-0099',
  phase: 3,
  status: 'Approved',
  envelope: makeEnvelope(),
  tasks: [makeTask()]
};

const INPUT = {
  worktreePath: '/runs/run-1/worktrees/T-01',
  branch: 'sdlc/run-1/T-01',
  runId: 'run-1',
  spec: SPEC,
  task: SPEC.tasks[0],
  verdicts: []
};

describe('PrLifecycleService (P3 T-02)', () => {
  let service: IPrLifecycleService;
  let push: jest.Mock;
  let findByBranch: jest.Mock;
  let create: jest.Mock;

  beforeEach(() => {
    push = jest.fn();
    findByBranch = jest.fn().mockReturnValue(null);
    create = jest.fn().mockReturnValue({
      url: 'https://github.com/org/repo/pull/9',
      number: 9
    });

    const container = new Container();
    container
      .bind<IGitRepository>(WORKFLOW_TOKENS.GitRepository)
      .toConstantValue({
        push,
        headSha: jest.fn(),
        status: jest.fn(),
        addWorktree: jest.fn(),
        diffStat: jest.fn(),
        diffText: jest.fn(),
        fetch: jest.fn(),
        resolveSha: jest.fn(),
        defaultBranch: jest.fn(),
        revertMerge: jest.fn(),
        stageAll: jest.fn(),
        commit: jest.fn(),
        removeWorktreeAsync: jest.fn()
      });
    container
      .bind<IPullRequestRepository>(WORKFLOW_TOKENS.PullRequestRepository)
      .toConstantValue({
        findByBranch,
        create,
        merge: jest.fn(),
        comment: jest.fn()
      });
    container
      .bind<IPrLifecycleService>(WORKFLOW_TOKENS.PrLifecycleService)
      .to(PrLifecycleService);
    service = container.get<IPrLifecycleService>(
      WORKFLOW_TOKENS.PrLifecycleService
    );
  });

  it('pushes the branch from the worktree and opens a PR with deterministic content', () => {
    const outcome = service.openTaskPr(INPUT);

    expect(push).toHaveBeenCalledWith(
      '/runs/run-1/worktrees/T-01',
      'sdlc/run-1/T-01'
    );
    expect(create).toHaveBeenCalledWith('/runs/run-1/worktrees/T-01', {
      branch: 'sdlc/run-1/T-01',
      title: prTitle('run-1', SPEC.tasks[0]),
      body: prBody(SPEC, SPEC.tasks[0], 'run-1', 'sdlc/run-1/T-01', [])
    });
    expect(outcome).toEqual({
      url: 'https://github.com/org/repo/pull/9',
      number: 9,
      created: true
    });
    // Determinism: the same inputs always produce the same PR text.
    expect(prTitle('run-1', SPEC.tasks[0])).toBe(
      prTitle('run-1', SPEC.tasks[0])
    );
    expect(prBody(SPEC, SPEC.tasks[0], 'run-1', 'sdlc/run-1/T-01', [])).toBe(
      prBody(SPEC, SPEC.tasks[0], 'run-1', 'sdlc/run-1/T-01', [])
    );
    expect(prTitle('run-1', SPEC.tasks[0])).toContain('T-01');
    const body = prBody(SPEC, SPEC.tasks[0], 'run-1', 'sdlc/run-1/T-01', []);
    expect(body).toContain(SPEC.id);
    expect(body).toContain(SPEC.tasks[0].acceptanceCriteria[0]);
  });

  it('reuses an existing open PR for the branch — no duplicate', () => {
    findByBranch.mockReturnValue({
      url: 'https://github.com/org/repo/pull/4',
      number: 4
    });

    const outcome = service.openTaskPr(INPUT);

    expect(push).toHaveBeenCalledTimes(1); // still pushes the latest head
    expect(create).not.toHaveBeenCalled();
    expect(outcome).toEqual({
      url: 'https://github.com/org/repo/pull/4',
      number: 4,
      created: false
    });
  });

  it('propagates typed push failures without touching the PR API', () => {
    push.mockImplementation(() => {
      throw new WorkflowError('git push failed', 'GIT_FAILED', ['rejected']);
    });

    expect(() => service.openTaskPr(INPUT)).toThrow(WorkflowError);
    expect(findByBranch).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });
});
