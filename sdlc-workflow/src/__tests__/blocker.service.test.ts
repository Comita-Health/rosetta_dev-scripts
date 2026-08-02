import 'reflect-metadata';
import { Container } from 'inversify';
import type { IGitHubIssueRepository } from '../repositories/github-issue.repository';
import type { IRunStateRepository } from '../repositories/run-state.repository';
import { BlockerService, IBlockerService } from '../services/blocker.service';
import { WORKFLOW_TOKENS } from '../tokens';
import { ExceptionEntry, RunState } from '../types';

const exception = (
  trigger: ExceptionEntry['trigger'],
  taskId = 'T-01'
): ExceptionEntry => ({ trigger, taskId, context: [], recordedAt: 'x' });

const stateWith = (exceptions: ExceptionEntry[]): RunState =>
  ({
    runId: 'run-1',
    specId: 'SPEC-1',
    specPath: '/spec.md',
    baseSha: 'base',
    taskResults: {},
    verdicts: [],
    exceptions,
    criterionVerdicts: [],
    steps: {},
    ciFixAttempts: {},
    tokenSpendK: 0
  }) as unknown as RunState;

describe('BlockerService', () => {
  let service: IBlockerService;
  let load: jest.Mock;
  let isResolved: jest.Mock;

  const build = (): void => {
    const container = new Container();
    container
      .bind<IRunStateRepository>(WORKFLOW_TOKENS.RunStateRepository)
      .toConstantValue({ load } as unknown as IRunStateRepository);
    container
      .bind<IGitHubIssueRepository>(WORKFLOW_TOKENS.GitHubIssueRepository)
      .toConstantValue({
        isResolved,
        upsert: jest.fn(),
        findOpenByLabel: jest.fn(),
        ensureLabel: jest.fn()
      });
    container
      .bind<IBlockerService>(WORKFLOW_TOKENS.BlockerService)
      .to(BlockerService);
    service = container.get(WORKFLOW_TOKENS.BlockerService);
  };

  beforeEach(() => {
    load = jest.fn();
    isResolved = jest.fn().mockReturnValue(false);
    build();
  });

  const query = (): ReturnType<IBlockerService['query']> =>
    service.query({ runsDir: '/runs', runId: 'run-1', repoPath: '/repo' });

  it('throws typed when the run has no state', () => {
    load.mockReturnValue(null);

    expect(() => query()).toThrow(
      expect.objectContaining({ code: 'RUN_NOT_FOUND' })
    );
  });

  it('is not resumable with no recorded exceptions', () => {
    load.mockReturnValue(stateWith([]));

    const report = query();

    expect(report.blockers).toEqual([]);
    expect(report.resumable).toBe(false);
  });

  it('reports an open blocker while its issue is still open', () => {
    load.mockReturnValue(stateWith([exception('envelope-breach')]));

    const report = query();

    expect(report.blockers).toEqual([
      {
        taskId: 'T-01',
        trigger: 'envelope-breach',
        key: 'run-1/T-01/envelope-breach',
        state: 'open'
      }
    ]);
    expect(report.resumable).toBe(false);
  });

  it('becomes resumable once every blocker issue is closed', () => {
    load.mockReturnValue(
      stateWith([exception('envelope-breach'), exception('no-commit', 'T-02')])
    );
    isResolved.mockReturnValue(true);

    const report = query();

    expect(report.blockers.map(b => b.state)).toEqual(['cleared', 'cleared']);
    expect(report.resumable).toBe(true);
  });

  it('stays blocked while any one issue is open', () => {
    load.mockReturnValue(
      stateWith([exception('envelope-breach'), exception('no-commit', 'T-02')])
    );
    isResolved.mockImplementation((_repo: string, key: string) =>
      key.includes('T-01')
    );

    expect(query().resumable).toBe(false);
  });

  it('collapses repeated exceptions onto the one issue backing them', () => {
    load.mockReturnValue(
      stateWith([exception('no-commit'), exception('no-commit')])
    );

    const report = query();

    expect(report.blockers).toHaveLength(1);
    expect(isResolved).toHaveBeenCalledTimes(1);
  });
});
