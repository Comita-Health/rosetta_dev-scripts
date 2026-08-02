import type { RunState, SpecDocument } from '../types';

/**
 * True when every task in the spec has a `mergedSha` recorded on the run.
 * Used by the supervise wave loop to know the phase is complete.
 */
export const allTasksMerged = (
  spec: SpecDocument,
  state: RunState | null
): boolean => {
  if (state === null) {
    return false;
  }
  if (spec.tasks.length === 0) {
    return false;
  }
  return spec.tasks.every(task => {
    const result = state.taskResults[task.id];
    return result?.mergedSha !== undefined && result.mergedSha.length > 0;
  });
};

/**
 * True when at least one task completed implementation but is not yet merged
 * (typical shadow-mode human gate).
 */
export const hasUnmergedCompletedTasks = (state: RunState | null): boolean => {
  if (state === null) {
    return false;
  }
  return Object.values(state.taskResults).some(result => {
    const completed = result.status === 'completed';
    const unmerged =
      result.mergedSha === undefined || result.mergedSha.length === 0;
    return completed && unmerged;
  });
};

/**
 * Enforce-mode halt: implementation finished and phase/merge is red, so the
 * task will not unlock dependents. Supervise should exit failed (not spin a
 * "no ready task" wave).
 */
export const hasMergeBlockedHalt = (
  state: RunState | null,
  taskIds: readonly string[]
): boolean => {
  if (state === null || taskIds.length === 0) {
    return false;
  }
  return taskIds.some(taskId => {
    const result = state.taskResults[taskId];
    if (result === undefined || result.status !== 'completed') {
      return false;
    }
    if (result.mergedSha !== undefined && result.mergedSha.length > 0) {
      return false;
    }
    const phaseBreach = Object.values(state.steps).some(
      step =>
        step.taskId === taskId &&
        step.name === 'phase' &&
        step.verdict?.outcome === 'breach'
    );
    const mergeBlocked = state.exceptions.some(
      entry => entry.taskId === taskId && entry.trigger === 'merge-blocked'
    );
    return phaseBreach || mergeBlocked;
  });
};
