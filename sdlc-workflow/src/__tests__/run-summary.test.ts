import { categorizeTasks } from '../utils/run-summary';
import { RunState, SpecDocument } from '../types';

const task = (
  id: string,
  dependsOn: string[] = []
): SpecDocument['tasks'][number] => ({
  id,
  storyId: 'S-01',
  phase: 3,
  title: id,
  engineeringNotes: '',
  complexity: 'S',
  dependsOn,
  acceptanceCriteria: ['test: a']
});

const SPEC: SpecDocument = {
  id: 'SPEC-X',
  prdId: 'PRD-X',
  phase: 3,
  status: 'Approved',
  envelope: {
    allowedPaths: ['**'],
    forbiddenSurfaces: [],
    maxDiffLines: 500,
    budgetK: 200
  },
  tasks: [task('T-01'), task('T-02', ['T-01']), task('T-03')]
};

const makeState = (overrides: Partial<RunState> = {}): RunState => ({
  runId: 'run-1',
  specId: 'SPEC-X',
  specPath: '/spec.md',
  baseSha: 'base',
  taskResults: {},
  verdicts: [],
  exceptions: [],
  criterionVerdicts: [],
  steps: {},
  tokenSpendK: 0,
  ciFixAttempts: {},
  gateFixAttempts: {},
  operatorUnstickAttempts: {},
  operatorUnstickOutcomes: {},
  escalateTiers: {},
  remediations: {},
  mergeBlockedRetries: 0,
  updatedAt: 'x',
  ...overrides
});

describe('categorizeTasks (P3 T-06 run summary)', () => {
  it('reports a mix of merged, escalated, and dependency-blocked tasks', () => {
    const state = makeState({
      taskResults: {
        'T-01': {
          taskId: 'T-01',
          status: 'completed',
          // Escalated and unmerged — blocks T-02.
          recordedAt: 'x'
        },
        'T-03': {
          taskId: 'T-03',
          status: 'completed',
          mergedSha: 'ccc',
          recordedAt: 'x'
        }
      },
      exceptions: [
        {
          trigger: 'reviewer-disagreement',
          taskId: 'T-01',
          context: ['disagree'],
          recordedAt: 'x'
        }
      ]
    });

    const categories = Object.fromEntries(
      categorizeTasks(SPEC, state).map(entry => [entry.taskId, entry.category])
    );

    expect(categories).toEqual({
      'T-01': 'halted-escalated',
      'T-02': 'blocked-by-dependency',
      'T-03': 'merged'
    });
  });

  it('prefers merged over escalated and surfaces failed / not-started', () => {
    const state = makeState({
      taskResults: {
        'T-01': {
          taskId: 'T-01',
          status: 'completed',
          mergedSha: 'aaa',
          recordedAt: 'x'
        },
        'T-03': {
          taskId: 'T-03',
          status: 'failed',
          detail: 'agent blew up',
          recordedAt: 'x'
        }
      },
      exceptions: [
        {
          trigger: 'merge-blocked',
          taskId: 'T-01',
          context: ['should not matter — already merged'],
          recordedAt: 'x'
        }
      ]
    });

    const byId = Object.fromEntries(
      categorizeTasks(SPEC, state).map(entry => [entry.taskId, entry])
    );
    expect(byId['T-01'].category).toBe('merged');
    // T-01 is merged, so T-02's dependency is satisfied → not-started.
    expect(byId['T-02'].category).toBe('not-started');
    expect(byId['T-03']).toEqual(
      expect.objectContaining({
        category: 'failed',
        detail: 'agent blew up'
      })
    );
  });
});
