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

const latestPhaseOutcome = (
  state: RunState,
  taskId: string
): 'pass' | 'breach' | undefined => {
  const phases = Object.values(state.steps).filter(
    step => step.name === 'phase' && step.taskId === taskId
  );
  if (phases.length === 0) {
    return undefined;
  }
  const latest = phases.reduce((best, step) =>
    step.completedAt > best.completedAt ? step : best
  );
  const outcome = latest.verdict?.outcome;
  if (outcome === 'pass' || outcome === 'breach') {
    return outcome;
  }
  return undefined;
};

/**
 * Enforce-mode halt: implementation finished and the *latest* phase is red,
 * or a merge call failed after a green phase — so dependents stay locked.
 * Supervise exits failed (not an empty "no ready task" wave).
 *
 * Stale `merge-blocked` exceptions from an earlier red phase must not halt
 * once the latest phase is pass (operator fixed gates / conflicts and resumed).
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
    const phaseOutcome = latestPhaseOutcome(state, taskId);
    if (phaseOutcome === 'breach') {
      return true;
    }
    if (phaseOutcome !== 'pass') {
      return false;
    }
    // Green phase but still unmerged: halt only when the latest merge attempt
    // failed (exception context), so resume can retry after the operator fixes
    // conflicts — selectReadyTasks re-picks pass+unmerged tasks.
    const mergeFail = state.exceptions.some(
      entry =>
        entry.taskId === taskId &&
        entry.trigger === 'merge-blocked' &&
        entry.context.some(line => line.includes('merge call failed'))
    );
    return mergeFail;
  });
};
