import { Envelope, SpecTask } from '../types';

const TIER_TAG = /^(test|agent|manual):\s+\S/;

/**
 * ADR-0008 format rules: every acceptance criterion carries a tier tag,
 * task dependencies must reference known task IDs, and the envelope must be
 * complete. Returns all violations, not just the first.
 */
export const validateSpec = (
  tasks: SpecTask[],
  envelope: Envelope
): string[] => {
  const errors: string[] = [];
  const taskIds = new Set(tasks.map(t => t.id));

  if (tasks.length === 0) {
    errors.push('spec contains no tasks');
  }

  for (const task of tasks) {
    if (task.acceptanceCriteria.length === 0) {
      errors.push(`Task ${task.id}: no acceptance criteria`);
    }
    for (const criterion of task.acceptanceCriteria) {
      if (!TIER_TAG.test(criterion)) {
        errors.push(
          `Task ${task.id}: criterion "${criterion}" is missing a ` +
            `verification-tier tag (test: | agent: | manual:)`
        );
      }
    }
    for (const dep of task.dependsOn) {
      if (!taskIds.has(dep)) {
        errors.push(`Task ${task.id}: depends on unknown task "${dep}"`);
      }
    }
  }

  if (envelope.allowedPaths.length === 0) {
    errors.push('envelope: allowedPaths must not be empty');
  }
  if (!Number.isFinite(envelope.maxDiffLines) || envelope.maxDiffLines <= 0) {
    errors.push('envelope: maxDiffLines must be a positive number');
  }
  if (!Number.isFinite(envelope.budgetK) || envelope.budgetK <= 0) {
    errors.push('envelope: budgetK must be a positive number');
  }

  return errors;
};
