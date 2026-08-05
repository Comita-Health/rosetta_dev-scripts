import {
  allTasksMerged,
  closeoutSatisfies,
  hasMergeBlockedHalt,
  hasUnmergedCompletedTasks,
  phaseComplete
} from '../utils/run-completion';
import type { RunState, SpecDocument, StepResult } from '../types';

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
    gateFixAttempts: {},
    remediations: {},
    mergeBlockedRetries: 0,
    tokenSpendK: 0,
    updatedAt: 't'
  }) as RunState;

describe('run-completion', () => {
  it('allTasksMerged requires every spec task to have a mergedSha', () => {
    expect(allTasksMerged(spec(['T-01', 'T-02']), null)).toBe(false);
    expect(allTasksMerged(spec([]), state({}))).toBe(false);
    expect(
      allTasksMerged(spec(['T-01', 'T-02']), state({ 'T-01': 'aaa' }))
    ).toBe(false);
    expect(
      allTasksMerged(
        spec(['T-01', 'T-02']),
        state({ 'T-01': 'aaa', 'T-02': 'bbb' })
      )
    ).toBe(true);
    expect(allTasksMerged(spec(['T-01']), state({ 'T-01': '' }))).toBe(false);
  });

  // SPEC-PRD-0023-P1 T-04: merged code with no derived closeout is exactly the
  // debt this phase exists to stop, so "all merged" stopped being sufficient.
  it('phaseComplete reports a fully merged phase with no closeout PR as incomplete', () => {
    expect(
      phaseComplete(
        spec(['T-01', 'T-02']),
        state({ 'T-01': 'aaa', 'T-02': 'bbb' }),
        null
      )
    ).toBe(false);
  });

  it('phaseComplete accepts an open closeout PR awaiting Approve', () => {
    expect(
      phaseComplete(
        spec(['T-01', 'T-02']),
        state({ 'T-01': 'aaa', 'T-02': 'bbb' }),
        { state: 'OPEN' }
      )
    ).toBe(true);
  });

  it('phaseComplete accepts a merged closeout PR', () => {
    expect(
      phaseComplete(spec(['T-01']), state({ 'T-01': 'aaa' }), {
        state: 'MERGED'
      })
    ).toBe(true);
  });

  it('phaseComplete rejects a closeout PR someone closed unmerged', () => {
    expect(
      phaseComplete(spec(['T-01']), state({ 'T-01': 'aaa' }), {
        state: 'CLOSED'
      })
    ).toBe(false);
    expect(closeoutSatisfies('CLOSED')).toBe(false);
    expect(closeoutSatisfies('OPEN')).toBe(true);
    expect(closeoutSatisfies('MERGED')).toBe(true);
  });

  it('phaseComplete still requires the merges, closeout PR or not', () => {
    expect(
      phaseComplete(spec(['T-01', 'T-02']), state({ 'T-01': 'aaa' }), {
        state: 'MERGED'
      })
    ).toBe(false);
    expect(phaseComplete(spec(['T-01']), null, { state: 'MERGED' })).toBe(false);
  });

  it('hasUnmergedCompletedTasks detects shadow human-gate state', () => {
    expect(hasUnmergedCompletedTasks(null)).toBe(false);
    expect(hasUnmergedCompletedTasks(state({ 'T-01': 'aaa' }))).toBe(false);
    expect(hasUnmergedCompletedTasks(state({ 'T-01': undefined }))).toBe(true);
  });

  it('hasMergeBlockedHalt detects unmerged completed tasks with phase breach', () => {
    const s = state({ 'T-01': undefined });
    s.steps = {
      'phase:T-01': {
        name: 'phase',
        taskId: 'T-01',
        inputsDigest: 'x',
        verdict: {
          gate: 'phase',
          outcome: 'breach',
          wouldEscalate: true,
          reasons: ['failing gates: envelope'],
          recordedAt: 't'
        },
        completedAt: 't'
      } as StepResult
    };
    expect(hasMergeBlockedHalt(null, ['T-01'])).toBe(false);
    expect(hasMergeBlockedHalt(s, ['T-01'])).toBe(true);
    expect(hasMergeBlockedHalt(state({ 'T-01': 'merged' }), ['T-01'])).toBe(
      false
    );
  });

  it('hasMergeBlockedHalt ignores stale gate merge-blocked once latest phase is pass', () => {
    const s = state({ 'T-01': undefined });
    s.steps = {
      'phase:T-01:old': {
        name: 'phase',
        taskId: 'T-01',
        inputsDigest: 'old',
        verdict: {
          gate: 'phase',
          outcome: 'breach',
          wouldEscalate: true,
          reasons: ['failing gates: envelope'],
          recordedAt: 't0'
        },
        completedAt: 't0'
      } as StepResult,
      'phase:T-01:new': {
        name: 'phase',
        taskId: 'T-01',
        inputsDigest: 'new',
        verdict: {
          gate: 'phase',
          outcome: 'pass',
          wouldEscalate: false,
          reasons: [],
          recordedAt: 't1'
        },
        completedAt: 't1'
      } as StepResult
    };
    s.exceptions = [
      {
        trigger: 'merge-blocked',
        taskId: 'T-01',
        context: ['failing gates: envelope'],
        recordedAt: 't0'
      }
    ];
    expect(hasMergeBlockedHalt(s, ['T-01'])).toBe(false);
  });

  it('hasMergeBlockedHalt stops on merge call failure after a green phase', () => {
    const s = state({ 'T-01': undefined });
    s.steps = {
      'phase:T-01': {
        name: 'phase',
        taskId: 'T-01',
        inputsDigest: 'x',
        verdict: {
          gate: 'phase',
          outcome: 'pass',
          wouldEscalate: false,
          reasons: [],
          recordedAt: 't'
        },
        completedAt: 't'
      } as StepResult
    };
    s.exceptions = [
      {
        trigger: 'merge-blocked',
        taskId: 'T-01',
        context: ['merge call failed: Pull Request has merge conflicts'],
        recordedAt: 't'
      }
    ];
    expect(hasMergeBlockedHalt(s, ['T-01'])).toBe(true);
  });
});
