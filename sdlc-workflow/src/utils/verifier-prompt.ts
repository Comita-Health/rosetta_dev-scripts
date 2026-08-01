import { SpecTask } from '../types';

/**
 * Build the verifier-agent prompt for one agent-tier criterion
 * (SPEC-PRD-0011-P2 T-04). Independence from the implementation agent is
 * structural: the prompt is built from the criterion, the task heading,
 * and the sandbox health report only — never from implementation
 * conversation state.
 */
export const buildVerifierPrompt = (
  task: SpecTask,
  criterion: string,
  sandboxHealth: string
): string =>
  [
    'You are an independent acceptance verifier. You have no context beyond',
    'what is below. Exercise the running sandbox interface described by the',
    'health report to decide whether this acceptance criterion is satisfied.',
    '',
    `## Task ${task.id}: ${task.title}`,
    '',
    '## Criterion under verification',
    '',
    criterion,
    '',
    '## Sandbox health report',
    '',
    sandboxHealth,
    '',
    'Verify the criterion against the live sandbox. Do not modify any code.',
    'End your reply with a fenced JSON object exactly of the form:',
    '```json',
    '{ "pass": true, "notes": ["..."] }',
    '```'
  ].join('\n');
