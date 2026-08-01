import { RunState } from '../types';
import { taskIntegrationTip } from '../utils/task-base';
import { makeTask } from './fixtures';

const baseState = (): RunState => ({
  runId: 'run-1',
  specId: 'SPEC-PRD-0099-P2',
  specPath: '/specs/spec.md',
  baseSha: 'frozen-base',
  taskResults: {},
  verdicts: [],
  exceptions: [],
  criterionVerdicts: [],
  steps: {},
  tokenSpendK: 0,
  ciFixAttempts: {},
  updatedAt: 'x'
});

describe('taskIntegrationTip (#42 / F1)', () => {
  it('returns the frozen run baseSha for tasks with no dependencies', () => {
    const tip = taskIntegrationTip(baseState(), makeTask({ id: 'T-01' }));
    expect(tip).toBe('frozen-base');
  });

  it('prefers state.mergedSha when dependencies exist', () => {
    const state = baseState();
    state.mergedSha = 'integration-tip';
    state.taskResults['T-01'] = {
      taskId: 'T-01',
      status: 'completed',
      mergedSha: 'dep-merge-older',
      recordedAt: 'x'
    };
    const tip = taskIntegrationTip(
      state,
      makeTask({ id: 'T-02', dependsOn: ['T-01'] })
    );
    expect(tip).toBe('integration-tip');
  });

  it('falls back to the last dependency mergedSha when mergedSha is unset', () => {
    const state = baseState();
    state.taskResults['T-01'] = {
      taskId: 'T-01',
      status: 'completed',
      mergedSha: 'merge-t01',
      recordedAt: 'x'
    };
    state.taskResults['T-03'] = {
      taskId: 'T-03',
      status: 'completed',
      mergedSha: 'merge-t03',
      recordedAt: 'x'
    };
    const tip = taskIntegrationTip(
      state,
      makeTask({ id: 'T-04', dependsOn: ['T-01', 'T-03'] })
    );
    expect(tip).toBe('merge-t03');
  });

  it('falls back to frozen baseSha when deps list is non-empty but no SHAs recorded', () => {
    const tip = taskIntegrationTip(
      baseState(),
      makeTask({ id: 'T-02', dependsOn: ['T-01'] })
    );
    expect(tip).toBe('frozen-base');
  });
});
