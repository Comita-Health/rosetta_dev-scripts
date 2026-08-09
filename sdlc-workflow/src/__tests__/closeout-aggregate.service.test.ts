import 'reflect-metadata';
import { Container } from 'inversify';
import {
  CloseoutAggregateService,
  type ICloseoutAggregateService
} from '../services/closeout-aggregate.service';
import type { IRunStateRepository } from '../repositories/run-state.repository';
import { WORKFLOW_TOKENS } from '../tokens';
import {
  CriterionVerdict,
  GateVerdict,
  RunState,
  SpecDocument,
  WorkflowError
} from '../types';
import { makeEnvelope, makeTask } from './fixtures';

const SPEC: SpecDocument = {
  id: 'SPEC-PRD-0099-P1',
  prdId: 'PRD-0099',
  phase: 1,
  status: 'Approved',
  envelope: makeEnvelope(),
  tasks: [
    makeTask({
      id: 'T-01',
      acceptanceCriteria: [
        'test: the thing builds',
        'agent: the sandbox serves it',
        'manual: a human eyeballs the layout'
      ]
    }),
    makeTask({ id: 'T-02', acceptanceCriteria: ['test: the other thing'] })
  ]
};

const state = (over: Partial<RunState> = {}): RunState => ({
  runId: 'run-7',
  specId: SPEC.id,
  specPath: '/repo/specs/PRD-0099/phase-1-spec.md',
  baseSha: 'base',
  taskResults: {},
  verdicts: [],
  exceptions: [],
  criterionVerdicts: [],
  steps: {},
  tokenSpendK: 0,
  ciFixAttempts: {},
  gateFixAttempts: {},
  remediations: {},
  mergeBlockedRetries: 0,
  updatedAt: 'x',
  ...over
});

const criterion = (
  over: Partial<CriterionVerdict> &
    Pick<CriterionVerdict, 'taskId' | 'criterion'>
): CriterionVerdict => ({
  tier: 'test',
  outcome: 'pass',
  recordedAt: '2026-08-01T00:00:00.000Z',
  ...over
});

const verdict = (over: Partial<GateVerdict>): GateVerdict => ({
  gate: 'verification',
  outcome: 'pass',
  wouldEscalate: false,
  reasons: [],
  recordedAt: '2026-08-01T00:00:00.000Z',
  ...over
});

describe('CloseoutAggregateService (SPEC-PRD-0023-P1 T-01)', () => {
  let load: jest.Mock;
  let service: ICloseoutAggregateService;

  const build = (runState: RunState | null): void => {
    load = jest.fn().mockReturnValue(runState);
    const container = new Container();
    container
      .bind<IRunStateRepository>(WORKFLOW_TOKENS.RunStateRepository)
      .toConstantValue({ load } as unknown as IRunStateRepository);
    container
      .bind<ICloseoutAggregateService>(WORKFLOW_TOKENS.CloseoutAggregateService)
      .to(CloseoutAggregateService);
    service = container.get(WORKFLOW_TOKENS.CloseoutAggregateService);
  };

  const aggregate = (runState: RunState | null) => {
    build(runState);
    return service.aggregate({
      runsDir: '/runs',
      runId: 'run-7',
      spec: SPEC
    });
  };

  it('returns one record per (task, gate) with evidence links when present', () => {
    const result = aggregate(
      state({
        verdicts: [
          verdict({
            taskId: 'T-01',
            gate: 'verification',
            evidenceIds: ['T-01-test-output']
          }),
          verdict({ taskId: 'T-01', gate: 'envelope' }),
          verdict({ taskId: 'T-02', gate: 'verification', outcome: 'breach' })
        ]
      })
    );

    expect(result.taskGates).toEqual([
      {
        taskId: 'T-01',
        gate: 'envelope',
        outcome: 'pass',
        evidenceLinks: [],
        recordedAt: '2026-08-01T00:00:00.000Z'
      },
      {
        taskId: 'T-01',
        gate: 'verification',
        outcome: 'pass',
        evidenceLinks: ['runs://run-7/evidence/T-01-test-output'],
        recordedAt: '2026-08-01T00:00:00.000Z'
      },
      {
        taskId: 'T-02',
        gate: 'verification',
        outcome: 'breach',
        evidenceLinks: [],
        recordedAt: '2026-08-01T00:00:00.000Z'
      }
    ]);
  });

  it('reports mixed pass, fail and missing coverage across every criterion', () => {
    const result = aggregate(
      state({
        criterionVerdicts: [
          criterion({
            taskId: 'T-01',
            criterion: 'test: the thing builds',
            evidenceId: 'T-01-test-output'
          }),
          criterion({
            taskId: 'T-01',
            criterion: 'agent: the sandbox serves it',
            tier: 'agent',
            outcome: 'fail',
            evidenceId: 'T-01-agent-criterion-2'
          }),
          criterion({
            taskId: 'T-01',
            criterion: 'manual: a human eyeballs the layout',
            tier: 'manual',
            outcome: 'human-required'
          })
        ]
      })
    );

    expect(
      result.criteria.map(item => [item.criterionId, item.coverage])
    ).toEqual([
      ['T-01#1', 'pass'],
      ['T-01#2', 'fail'],
      ['T-01#3', 'human-required'],
      ['T-02#1', 'no-verdict']
    ]);
    expect(result.criteria[0].evidenceLink).toBe(
      'runs://run-7/evidence/T-01-test-output'
    );
    expect(result.criteria[3].evidenceLink).toBeUndefined();
  });

  it('keeps an unjudged criterion in the result rather than omitting it', () => {
    const result = aggregate(state());

    expect(result.criteria).toHaveLength(4);
    expect(result.criteria.every(item => item.coverage === 'no-verdict')).toBe(
      true
    );
    // The tier still comes through, so the remainder can say *why* a
    // criterion is outstanding without a verdict to read it from.
    expect(result.criteria.map(item => item.tier)).toEqual([
      'test',
      'agent',
      'manual',
      'test'
    ]);
  });

  it('carries every declared task so the remainder can name phase-level gaps', () => {
    const result = aggregate(state());

    // Criteria alone cannot answer "which task never merged" for a task whose
    // criteria all happen to pass.
    expect(result.taskIds).toEqual(['T-01', 'T-02']);
    expect(result.mergedTaskIds).toEqual([]);
    expect(result.phasePassedTaskIds).toEqual([]);
  });

  it('reads a docs-tier criterion instead of throwing on it', () => {
    // spec-lint accepts `docs:`; this used to reject it, so closing out a spec
    // with a docs criterion failed outright.
    const withDocs: SpecDocument = {
      ...SPEC,
      tasks: [
        makeTask({
          id: 'T-01',
          acceptanceCriteria: ['docs: the README covers the contract']
        })
      ]
    };
    build(state());

    const result = service.aggregate({
      runsDir: '/runs',
      runId: 'run-7',
      spec: withDocs
    });

    expect(result.criteria).toEqual([
      expect.objectContaining({ tier: 'docs', coverage: 'no-verdict' })
    ]);
  });

  it('prefers the newest verdict when a criterion was re-judged', () => {
    const result = aggregate(
      state({
        criterionVerdicts: [
          criterion({
            taskId: 'T-01',
            criterion: 'test: the thing builds',
            outcome: 'fail',
            recordedAt: '2026-08-01T00:00:00.000Z'
          }),
          criterion({
            taskId: 'T-01',
            criterion: 'test: the thing builds',
            outcome: 'pass',
            recordedAt: '2026-08-02T00:00:00.000Z',
            evidenceId: 'retry-output'
          })
        ]
      })
    );

    expect(result.criteria[0].coverage).toBe('pass');
    expect(result.criteria[0].evidenceLink).toBe(
      'runs://run-7/evidence/retry-output'
    );
  });

  it('reports full coverage only when every criterion, phase gate and merge is in', () => {
    const complete = state({
      taskResults: {
        'T-01': {
          taskId: 'T-01',
          status: 'completed',
          mergedSha: 'a',
          recordedAt: 'x'
        },
        'T-02': {
          taskId: 'T-02',
          status: 'completed',
          mergedSha: 'b',
          recordedAt: 'x'
        }
      },
      verdicts: [
        verdict({ taskId: 'T-01', gate: 'phase' }),
        verdict({ taskId: 'T-02', gate: 'phase' })
      ],
      criterionVerdicts: SPEC.tasks.flatMap(task =>
        task.acceptanceCriteria.map(text =>
          criterion({ taskId: task.id, criterion: text })
        )
      )
    });

    expect(aggregate(complete).fullyCovered).toBe(true);
    expect(aggregate(complete).mergedTaskIds).toEqual(['T-01', 'T-02']);
    expect(aggregate(complete).phasePassedTaskIds).toEqual(['T-01', 'T-02']);
  });

  it('withholds full coverage when a task merged without a green phase gate', () => {
    const result = aggregate(
      state({
        taskResults: {
          'T-01': {
            taskId: 'T-01',
            status: 'completed',
            mergedSha: 'a',
            recordedAt: 'x'
          },
          'T-02': {
            taskId: 'T-02',
            status: 'completed',
            mergedSha: 'b',
            recordedAt: 'x'
          }
        },
        verdicts: [
          verdict({ taskId: 'T-01', gate: 'phase' }),
          verdict({ taskId: 'T-02', gate: 'phase', outcome: 'breach' })
        ],
        criterionVerdicts: SPEC.tasks.flatMap(task =>
          task.acceptanceCriteria.map(text =>
            criterion({ taskId: task.id, criterion: text })
          )
        )
      })
    );

    expect(result.fullyCovered).toBe(false);
    expect(result.phasePassedTaskIds).toEqual(['T-01']);
  });

  it('#169: treats phase:stood + mergedSha as phase coverage for Done', () => {
    const complete = state({
      taskResults: {
        'T-01': {
          taskId: 'T-01',
          status: 'completed',
          mergedSha: 'a',
          recordedAt: 'x'
        },
        'T-02': {
          taskId: 'T-02',
          status: 'completed',
          mergedSha: 'b',
          recordedAt: 'x'
        }
      },
      verdicts: [
        verdict({ taskId: 'T-01', gate: 'phase', outcome: 'breach' }),
        verdict({
          taskId: 'T-01',
          gate: 'phase',
          outcome: 'stood',
          recordedAt: '2026-08-05T12:00:00.000Z'
        }),
        verdict({ taskId: 'T-02', gate: 'phase', outcome: 'stood' })
      ],
      criterionVerdicts: SPEC.tasks.flatMap(task =>
        task.acceptanceCriteria.map(text =>
          criterion({ taskId: task.id, criterion: text })
        )
      )
    });

    expect(aggregate(complete).fullyCovered).toBe(true);
    expect(aggregate(complete).phasePassedTaskIds).toEqual(['T-01', 'T-02']);
  });

  it('#169: phase:stood without mergedSha is not coverage', () => {
    const result = aggregate(
      state({
        taskResults: {
          'T-01': {
            taskId: 'T-01',
            status: 'completed',
            recordedAt: 'x'
          }
        },
        verdicts: [verdict({ taskId: 'T-01', gate: 'phase', outcome: 'stood' })]
      })
    );

    expect(result.phasePassedTaskIds).toEqual([]);
    expect(result.fullyCovered).toBe(false);
  });

  it('reads the latest phase verdict, so a re-judged breach can clear', () => {
    const runState = state({
      taskResults: {
        'T-01': {
          taskId: 'T-01',
          status: 'completed',
          mergedSha: 'a',
          recordedAt: 'x'
        },
        'T-02': {
          taskId: 'T-02',
          status: 'completed',
          mergedSha: 'b',
          recordedAt: 'x'
        }
      },
      verdicts: [
        verdict({ taskId: 'T-01', gate: 'phase', outcome: 'breach' }),
        verdict({
          taskId: 'T-01',
          gate: 'phase',
          recordedAt: '2026-08-03T00:00:00.000Z'
        }),
        verdict({ taskId: 'T-02', gate: 'phase' })
      ]
    });

    expect(aggregate(runState).phasePassedTaskIds).toEqual(['T-01', 'T-02']);
  });

  it('withholds full coverage when a verified task never merged', () => {
    const result = aggregate(
      state({
        taskResults: {
          'T-01': {
            taskId: 'T-01',
            status: 'completed',
            mergedSha: 'a',
            recordedAt: 'x'
          }
        },
        verdicts: [
          verdict({ taskId: 'T-01', gate: 'phase' }),
          verdict({ taskId: 'T-02', gate: 'phase' })
        ],
        criterionVerdicts: SPEC.tasks.flatMap(task =>
          task.acceptanceCriteria.map(text =>
            criterion({ taskId: task.id, criterion: text })
          )
        )
      })
    );

    expect(result.fullyCovered).toBe(false);
    expect(result.mergedTaskIds).toEqual(['T-01']);
  });

  it('refuses a run it has no state for', () => {
    build(null);

    expect(() =>
      service.aggregate({ runsDir: '/runs', runId: 'run-7', spec: SPEC })
    ).toThrow(WorkflowError);
    expect(() =>
      service.aggregate({ runsDir: '/runs', runId: 'run-7', spec: SPEC })
    ).toThrow('run run-7 has no recorded state');
  });

  it('ignores run-level verdicts that belong to no task', () => {
    const result = aggregate(
      state({
        verdicts: [
          verdict({ gate: 'intake' }),
          verdict({ taskId: 'T-01', gate: 'ci' })
        ]
      })
    );

    expect(result.taskGates).toHaveLength(1);
    expect(result.taskGates[0].gate).toBe('ci');
  });

  it('records nothing — the aggregation is read-only', () => {
    build(state());
    service.aggregate({ runsDir: '/runs', runId: 'run-7', spec: SPEC });

    expect(load).toHaveBeenCalledWith('/runs', 'run-7');
    // A repository with only `load` bound proves the point: any write call
    // would have thrown on an undefined method.
    expect(Object.keys(load.mock.calls[0])).toHaveLength(2);
  });
});
