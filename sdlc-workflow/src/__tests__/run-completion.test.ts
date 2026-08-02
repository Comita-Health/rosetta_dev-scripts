import {
  allTasksMerged,
  hasUnmergedCompletedTasks
} from '../utils/run-completion';
import type { RunState, SpecDocument } from '../types';

const spec = (ids: string[]): SpecDocument =>
  ({
    id: 'SPEC-X',
    prdId: 'PRD-X',
    phase: 0,
    status: 'Approved',
    envelope: {
      allowedPaths: ['src/**'],
      forbiddenSurfaces: [],
      maxDiffLines: 100,
      budgetK: 10
    },
    tasks: ids.map(id => ({
      id,
      storyId: 'S-01',
      phase: 0,
      title: id,
      engineeringNotes: 'n',
      complexity: 'S' as const,
      dependsOn: [],
      acceptanceCriteria: ['test: x']
    }))
  }) as SpecDocument;

const state = (merged: Record<string, string | undefined>): RunState =>
  ({
    runId: 'r',
    specId: 'SPEC-X',
    specPath: '/s.md',
    baseSha: 'abc',
    taskResults: Object.fromEntries(
      Object.entries(merged).map(([taskId, mergedSha]) => [
        taskId,
        {
          taskId,
          status: 'completed' as const,
          mergedSha,
          recordedAt: 't'
        }
      ])
    ),
    verdicts: [],
    exceptions: [],
    criterionVerdicts: [],
    steps: {},
    ciFixAttempts: {},
    tokenSpendK: 0,
    updatedAt: 't'
  }) as RunState;

describe('run-completion', () => {
  it('allTasksMerged requires every spec task to have a mergedSha', () => {
    expect(allTasksMerged(spec(['T-01', 'T-02']), null)).toBe(false);
    expect(
      allTasksMerged(spec(['T-01', 'T-02']), state({ 'T-01': 'aaa' }))
    ).toBe(false);
    expect(
      allTasksMerged(
        spec(['T-01', 'T-02']),
        state({ 'T-01': 'aaa', 'T-02': 'bbb' })
      )
    ).toBe(true);
  });

  it('hasUnmergedCompletedTasks detects shadow human-gate state', () => {
    expect(hasUnmergedCompletedTasks(null)).toBe(false);
    expect(hasUnmergedCompletedTasks(state({ 'T-01': 'aaa' }))).toBe(false);
    expect(hasUnmergedCompletedTasks(state({ 'T-01': undefined }))).toBe(true);
  });
});
