import 'reflect-metadata';
import { Container } from 'inversify';
import type { IGitRepository } from '../repositories/git.repository';
import type { IPullRequestRepository } from '../repositories/pull-request.repository';
import type { ISpecFileRepository } from '../repositories/spec-file.repository';
import {
  CloseoutService,
  type ICloseoutService
} from '../services/closeout.service';
import { WORKFLOW_TOKENS } from '../tokens';
import { CloseoutAggregate, CloseoutCriterion, SpecDocument } from '../types';
import { closeoutBranch } from '../utils/spec-closeout';
import { makeEnvelope, makeTask } from './fixtures';

const SPEC: SpecDocument = {
  id: 'SPEC-PRD-0099-P1',
  prdId: 'PRD-0099',
  phase: 1,
  status: 'Approved',
  envelope: makeEnvelope(),
  tasks: [makeTask({ acceptanceCriteria: ['test: the thing builds'] })]
};

const BASE_MARKDOWN = `---
id: SPEC-PRD-0099-P1
prd: PRD-0099
phase: 1
status: Approved
date: 2026-08-04
owner: Russ Watson
envelope:
  allowedPaths: ['src/**']
  forbiddenSurfaces: ['ci-config']
  maxDiffLines: 1000
  budgetK: 200
---

# SPEC-PRD-0099-P1: do the thing

## Task T-01: Build the thing

- **Story:** S-01
- **Complexity:** M
- **Depends on:** []

### Acceptance criteria

- [ ] test: the thing builds
`;

const criterion: CloseoutCriterion = {
  criterionId: 'T-01#1',
  taskId: 'T-01',
  gate: 'verification',
  index: 1,
  criterion: 'test: the thing builds',
  tier: 'test',
  coverage: 'pass',
  evidenceLink: 'runs://run-7/evidence/T-01-test-output'
};

const AGGREGATE: CloseoutAggregate = {
  runId: 'run-7',
  specId: SPEC.id,
  criteria: [criterion],
  taskGates: [
    {
      taskId: 'T-01',
      gate: 'phase',
      outcome: 'pass',
      evidenceLinks: [],
      recordedAt: 'x'
    }
  ],
  mergedTaskIds: ['T-01'],
  phasePassedTaskIds: ['T-01'],
  fullyCovered: true
};

const BRANCH = closeoutBranch(SPEC.id);

describe('CloseoutService (SPEC-PRD-0023-P1 T-02 / T-03)', () => {
  let fetchOrigin: jest.Mock;
  let fileAtRef: jest.Mock;
  let worktreeForBranch: jest.Mock;
  let status: jest.Mock;
  let stageAll: jest.Mock;
  let commit: jest.Mock;
  let push: jest.Mock;
  let findByBranch: jest.Mock;
  let latestForBranch: jest.Mock;
  let create: jest.Mock;
  let updateBody: jest.Mock;
  let writeCloseout: jest.Mock;
  let service: ICloseoutService;

  beforeEach(() => {
    fetchOrigin = jest.fn();
    fileAtRef = jest.fn().mockReturnValue(BASE_MARKDOWN);
    worktreeForBranch = jest.fn();
    status = jest.fn().mockReturnValue(' M specs/PRD-0099/phase-1-spec.md\n');
    stageAll = jest.fn();
    commit = jest.fn();
    push = jest.fn();
    findByBranch = jest.fn().mockReturnValue(null);
    latestForBranch = jest.fn().mockReturnValue(null);
    create = jest
      .fn()
      .mockReturnValue({ url: 'https://github.com/o/r/pull/12', number: 12 });
    updateBody = jest.fn();
    writeCloseout = jest.fn();

    const container = new Container();
    container.bind<IGitRepository>(WORKFLOW_TOKENS.GitRepository).toConstantValue({
      fetch: fetchOrigin,
      defaultBranch: jest.fn().mockReturnValue('main'),
      resolveSha: jest.fn().mockReturnValue('main-sha'),
      fileAtRef,
      worktreeForBranch,
      status,
      stageAll,
      commit,
      push
    } as unknown as IGitRepository);
    container
      .bind<IPullRequestRepository>(WORKFLOW_TOKENS.PullRequestRepository)
      .toConstantValue({
        findByBranch,
        latestForBranch,
        create,
        updateBody,
        merge: jest.fn(),
        mergeCommitOid: jest.fn(),
        comment: jest.fn()
      });
    container
      .bind<ISpecFileRepository>(WORKFLOW_TOKENS.SpecFileRepository)
      .toConstantValue({ writeSpec: jest.fn(), writeCloseout });
    container
      .bind<ICloseoutService>(WORKFLOW_TOKENS.CloseoutService)
      .to(CloseoutService);
    service = container.get(WORKFLOW_TOKENS.CloseoutService);
  });

  const generate = (
    aggregate: CloseoutAggregate = AGGREGATE
  ): ReturnType<ICloseoutService['generate']> =>
    service.generate({
      repoPath: '/repo',
      runsDir: '/runs',
      runId: 'run-7',
      spec: SPEC,
      specRelPath: 'specs/PRD-0099/phase-1-spec.md',
      aggregate
    });

  it('opens the closeout PR with no manual authoring step', async () => {
    const outcome = await generate();

    expect(outcome.kind).toBe('created');
    expect(outcome.pr).toEqual({
      url: 'https://github.com/o/r/pull/12',
      number: 12
    });
    expect(create).toHaveBeenCalledTimes(1);
    const [, input] = create.mock.calls[0];
    expect(input.branch).toBe(BRANCH);
    // The body is a rendering of the aggregate — no operator input reaches it.
    expect(input.body).toContain('runs://run-7/evidence/T-01-test-output');
    expect(input.body).toContain('Nothing in this PR is hand-authored.');
  });

  it('derives the spec diff from the default branch, not the working tree', async () => {
    await generate();

    expect(fetchOrigin).toHaveBeenCalledWith('/repo');
    expect(fileAtRef).toHaveBeenCalledWith(
      '/repo',
      'origin/main',
      'specs/PRD-0099/phase-1-spec.md'
    );
    const [, , markdown] = writeCloseout.mock.calls[0];
    expect(markdown).toContain('- [x] test: the thing builds');
    expect(markdown).toContain('status: Done');
  });

  it('writes status: Done only through the privileged route', async () => {
    const outcome = await generate();

    expect(outcome.statusWritten).toBe('Done');
    expect(writeCloseout).toHaveBeenCalledWith(
      '/runs/run-7/worktrees/_closeout',
      'specs/PRD-0099/phase-1-spec.md',
      expect.stringContaining('status: Done')
    );
  });

  it('leaves the prior status alone when coverage is partial', async () => {
    const outcome = await generate({
      ...AGGREGATE,
      criteria: [{ ...criterion, coverage: 'fail' }],
      fullyCovered: false
    });

    // Nothing derived changed, so there is no diff to open a PR from.
    expect(outcome.kind).toBe('unchanged');
    expect(outcome.statusWritten).toBeUndefined();
    expect(create).not.toHaveBeenCalled();
    expect(outcome.detail).toContain('already matches the recorded verdicts');
  });

  it('updates the same PR number instead of opening a second one', async () => {
    findByBranch.mockReturnValue({
      url: 'https://github.com/o/r/pull/12',
      number: 12
    });

    const outcome = await generate();

    expect(outcome.kind).toBe('updated');
    expect(outcome.pr?.number).toBe(12);
    expect(create).not.toHaveBeenCalled();
    expect(updateBody).toHaveBeenCalledWith(
      '/runs/run-7/worktrees/_closeout',
      12,
      expect.stringContaining('Criteria passing: 1/1')
    );
  });

  it('reuses the closeout branch rather than branching per run', async () => {
    await generate();

    expect(worktreeForBranch).toHaveBeenCalledWith(
      '/repo',
      '/runs/run-7/worktrees/_closeout',
      BRANCH,
      'main-sha'
    );
    expect(push).toHaveBeenCalledWith(
      '/runs/run-7/worktrees/_closeout',
      BRANCH
    );
  });

  it('commits with sign-off and no hooks, since sdlc/* is not a repo branch prefix', async () => {
    await generate();

    expect(stageAll).toHaveBeenCalledWith('/runs/run-7/worktrees/_closeout');
    expect(commit).toHaveBeenCalledWith(
      '/runs/run-7/worktrees/_closeout',
      expect.stringContaining('docs(SPEC-PRD-0099-P1): closeout from run run-7'),
      { noVerify: true, signOff: true }
    );
    expect(commit.mock.calls[0][1]).toContain('status: Done');
  });

  it('still pushes and opens the PR when a resumed run left the commit in place', async () => {
    status.mockReturnValue('   \n');

    const outcome = await generate();

    expect(commit).not.toHaveBeenCalled();
    expect(push).toHaveBeenCalled();
    expect(outcome.kind).toBe('created');
  });

  it('reports the existing PR when the spec already matches the verdicts', async () => {
    fileAtRef.mockReturnValue(
      BASE_MARKDOWN.replace(
        '- [ ] test: the thing builds',
        '- [x] test: the thing builds'
      ).replace('status: Approved', 'status: Done')
    );
    latestForBranch.mockReturnValue({
      url: 'https://github.com/o/r/pull/12',
      number: 12,
      state: 'MERGED'
    });

    const outcome = await generate();

    expect(outcome.kind).toBe('unchanged');
    expect(outcome.pr?.number).toBe(12);
    expect(outcome.detail).toContain('is merged');
    expect(worktreeForBranch).not.toHaveBeenCalled();
  });

  it('skips a spec that is not on the default branch', async () => {
    fileAtRef.mockReturnValue(null);

    const outcome = await generate();

    expect(outcome.kind).toBe('skipped');
    expect(outcome.detail).toContain('is not present on origin/main');
    expect(outcome.remainderCount).toBe(1);
    expect(writeCloseout).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it('counts the remainder it is leaving behind', async () => {
    const outcome = await generate({
      ...AGGREGATE,
      criteria: [
        criterion,
        {
          ...criterion,
          criterionId: 'T-01#2',
          index: 2,
          criterion: 'manual: a human signs off',
          tier: 'manual',
          coverage: 'human-required'
        }
      ],
      fullyCovered: false
    });

    expect(outcome.tickedCount).toBe(1);
    expect(outcome.remainderCount).toBe(1);
    expect(outcome.statusWritten).toBeUndefined();
  });
});
