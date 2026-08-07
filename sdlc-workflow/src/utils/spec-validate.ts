import { Envelope, SpecTask } from '../types';

const TIER_TAG = /^(test|agent|manual):\s+\S/;

/**
 * ADR-0008 format rules: every acceptance criterion carries a tier tag,
 * task dependencies must reference known task IDs, and the envelope must be
 * complete. Returns all violations, not just the first.
 *
 * `knownSurfaces` are the labels defined in the target repo's
 * `.sdlc/surfaces.json`. Supply them wherever the repo is known: the envelope
 * gate fails closed on a label it cannot resolve, so an undefined label is an
 * unconditional breach on every task no matter what the diff contains. Caught
 * here it is a spec error; caught at the gate it has already cost a full wave
 * of agent work. Omit only when no repo context exists.
 */
export const validateSpec = (
  tasks: SpecTask[],
  envelope: Envelope,
  knownSurfaces?: string[]
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
  if (knownSurfaces !== undefined) {
    const defined = new Set(knownSurfaces);
    for (const label of envelope.forbiddenSurfaces) {
      if (!defined.has(label)) {
        errors.push(
          `envelope: forbiddenSurfaces label "${label}" is not defined in ` +
            `.sdlc/surfaces.json (defined: ${
              knownSurfaces.length > 0 ? knownSurfaces.join(', ') : 'none'
            })`
        );
      }
    }
  }
  if (!Number.isFinite(envelope.maxDiffLines) || envelope.maxDiffLines <= 0) {
    errors.push('envelope: maxDiffLines must be a positive number');
  }
  if (!Number.isFinite(envelope.budgetK) || envelope.budgetK <= 0) {
    errors.push('envelope: budgetK must be a positive number');
  }

  return errors;
};
