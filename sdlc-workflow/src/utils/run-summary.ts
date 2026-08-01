import { ExceptionEntry, RunState, SpecDocument, SpecTask } from '../types';

/**
 * P3 T-06 partial-failure categories. A run ending with a mix of outcomes
 * surfaces each task in exactly one category so the status interface tells
 * an operator what needs attention (PRD-0011 §6).
 */
export type TaskCategory =
  | 'merged'
  | 'halted-escalated'
  | 'blocked-by-dependency'
  | 'failed'
  | 'completed-unmerged'
  | 'not-started';

export interface CategorizedTask {
  taskId: string;
  title: string;
  category: TaskCategory;
  detail?: string;
}

const escalatedTaskIds = (exceptions: ExceptionEntry[]): Set<string> =>
  new Set(
    exceptions
      .map(entry => entry.taskId)
      .filter((id): id is string => id !== undefined)
  );

const depsMerged = (task: SpecTask, state: RunState): boolean =>
  task.dependsOn.every(dep => state.taskResults[dep]?.mergedSha !== undefined);

/**
 * Classify every task of a spec against the run state. Precedence:
 * merged → halted-escalated → failed → completed-unmerged →
 * blocked-by-dependency → not-started.
 */
export const categorizeTasks = (
  spec: SpecDocument,
  state: RunState
): CategorizedTask[] => {
  const escalated = escalatedTaskIds(state.exceptions);
  return spec.tasks.map(task => {
    const result = state.taskResults[task.id];
    if (result?.mergedSha !== undefined) {
      return {
        taskId: task.id,
        title: task.title,
        category: 'merged',
        detail: result.mergedSha
      };
    }
    if (escalated.has(task.id)) {
      const triggers = state.exceptions
        .filter(entry => entry.taskId === task.id)
        .map(entry => entry.trigger);
      return {
        taskId: task.id,
        title: task.title,
        category: 'halted-escalated',
        detail: triggers.join(', ')
      };
    }
    if (result?.status === 'failed') {
      return {
        taskId: task.id,
        title: task.title,
        category: 'failed',
        detail: result.detail
      };
    }
    if (result?.status === 'completed') {
      return {
        taskId: task.id,
        title: task.title,
        category: 'completed-unmerged'
      };
    }
    if (!depsMerged(task, state)) {
      return {
        taskId: task.id,
        title: task.title,
        category: 'blocked-by-dependency',
        detail: task.dependsOn
          .filter(dep => state.taskResults[dep]?.mergedSha === undefined)
          .join(', ')
      };
    }
    return { taskId: task.id, title: task.title, category: 'not-started' };
  });
};
