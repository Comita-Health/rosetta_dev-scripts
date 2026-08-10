import {
  BlockerService,
  type IBlockerService
} from '../services/blocker.service';
import type { ExceptionEntry, RunState } from '../types';

const exception = (
  trigger: ExceptionEntry['trigger'],
  taskId = 'T-01'
): ExceptionEntry => ({
  trigger,
  taskId,
  context: [],
  recordedAt: '2026-08-10T00:00:00.000Z'
});

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
    gateFixAttempts: {},
    remediations: {},
    mergeBlockedRetries: 0,
    tokenSpendK: 0,
    updatedAt: '2026-08-10T00:00:00.000Z'
  }) as RunState;

describe('BlockerService (SPEC-PRD-0020-P2 T-03)', () => {
  let service: IBlockerService;
  let load: jest.Mock;
  let findByTitle: jest.Mock;

  beforeEach(() => {
    load = jest.fn();
    findByTitle = jest.fn().mockReturnValue(null);
    service = new BlockerService({ load, idleSeconds: jest.fn() } as never, {
      findByTitle,
      create: jest.fn()
    });
  });

  const query = (): ReturnType<IBlockerService['query']> =>
    service.query({
      runsDir: '/runs',
      runId: 'run-1',
      repoPath: process.cwd()
    });

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

  it('reports an open blocker while its needs-human issue is still open', () => {
    load.mockReturnValue(stateWith([exception('envelope-breach')]));
    findByTitle.mockReturnValue({
      url: 'https://github.com/o/r/issues/1',
      number: 1
    });

    const report = query();
    expect(report.blockers).toEqual([
      expect.objectContaining({
        taskId: 'T-01',
        trigger: 'envelope-breach',
        state: 'open'
      })
    ]);
    expect(report.resumable).toBe(false);
  });

  it('becomes resumable once every blocker issue is closed', () => {
    load.mockReturnValue(
      stateWith([
        exception('envelope-breach'),
        exception('merge-blocked', 'T-02')
      ])
    );
    findByTitle.mockReturnValue(null);

    const report = query();
    expect(report.blockers.map(b => b.state)).toEqual(['cleared', 'cleared']);
    expect(report.resumable).toBe(true);
  });

  it('stays blocked while any one issue is open', () => {
    load.mockReturnValue(
      stateWith([
        exception('envelope-breach'),
        exception('merge-blocked', 'T-02')
      ])
    );
    findByTitle.mockImplementation((_repo: string, title: string) =>
      title.includes('T-01')
        ? { url: 'https://github.com/o/r/issues/1', number: 1 }
        : null
    );

    expect(query().resumable).toBe(false);
  });

  it('collapses repeated exceptions onto one blocker row', () => {
    load.mockReturnValue(
      stateWith([exception('merge-blocked'), exception('merge-blocked')])
    );

    const report = query();
    expect(report.blockers).toHaveLength(1);
    // Wave title + one unique legacy per-trigger title (deduped).
    expect(findByTitle).toHaveBeenCalledTimes(2);
  });

  it('treats any open legacy per-trigger issue as blocking the wave', () => {
    load.mockReturnValue(
      stateWith([
        exception('reviewer-disagreement'),
        exception('envelope-breach')
      ])
    );
    findByTitle.mockImplementation((_repo: string, title: string) =>
      title.includes('envelope-breach')
        ? { url: 'https://github.com/o/r/issues/93', number: 93 }
        : null
    );

    const report = query();
    expect(report.blockers).toHaveLength(1);
    expect(report.blockers[0]?.state).toBe('open');
    expect(report.resumable).toBe(false);
  });

  it('fails open when the issue probe throws', () => {
    load.mockReturnValue(stateWith([exception('merge-blocked')]));
    findByTitle.mockImplementation(() => {
      throw new Error('gh down');
    });

    expect(query()).toEqual({
      runId: 'run-1',
      blockers: [],
      resumable: false
    });
  });
});
