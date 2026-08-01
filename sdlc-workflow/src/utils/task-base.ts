import { RunState, SpecTask } from '../types';

/**
 * Integration tip a ready task should branch from — and the `baseRef`
 * envelope / reviewer gates must diff against (live-val #42 / F1).
 *
 * - No dependencies → frozen run `baseSha` (wave-1 tasks).
 * - Dependencies merged → post-merge integration tip from `record-merge` /
 *   auto-merge (`state.mergedSha`), falling back to the last dependency's
 *   `mergedSha`. Never the cumulative frozen-base range.
 *
 * Callers must only invoke this for tasks whose `dependsOn` are all merged
 * (the ready-task selector already enforces that).
 */
export const taskIntegrationTip = (state: RunState, task: SpecTask): string => {
  if (task.dependsOn.length === 0) {
    return state.baseSha;
  }

  if (state.mergedSha !== undefined && state.mergedSha.length > 0) {
    return state.mergedSha;
  }

  for (let i = task.dependsOn.length - 1; i >= 0; i -= 1) {
    const depId = task.dependsOn[i];
    const merged = state.taskResults[depId]?.mergedSha;
    if (merged !== undefined && merged.length > 0) {
      return merged;
    }
  }

  return state.baseSha;
};
