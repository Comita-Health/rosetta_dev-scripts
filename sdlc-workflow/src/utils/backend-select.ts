import { WorkflowError } from '../types';

export type InferenceBackend = 'anthropic' | 'openai' | 'cursor-cli';

const BACKENDS: readonly InferenceBackend[] = [
  'anthropic',
  'openai',
  'cursor-cli'
];

const hasValue = (value: string | undefined): boolean =>
  value !== undefined && value.length > 0;

/**
 * Select the completion transport (SPEC-PRD-0011-P1 T-03):
 * `SDLC_INFERENCE_BACKEND` wins when set; otherwise the first configured
 * API key wins (`ANTHROPIC_API_KEY`, then `OPENAI_API_KEY`), falling back
 * to the operator's `cursor-agent` session.
 */
export const resolveInferenceBackend = (
  env: NodeJS.ProcessEnv
): InferenceBackend => {
  const explicit = env.SDLC_INFERENCE_BACKEND;
  if (BACKENDS.includes(explicit as InferenceBackend)) {
    return explicit as InferenceBackend;
  }
  if (explicit !== undefined && explicit.length > 0) {
    throw new WorkflowError(
      `Unknown SDLC_INFERENCE_BACKEND "${explicit}" — expected ${BACKENDS.join(
        ' | '
      )}`,
      'INVALID_BACKEND'
    );
  }
  if (hasValue(env.ANTHROPIC_API_KEY)) return 'anthropic';
  if (hasValue(env.OPENAI_API_KEY)) return 'openai';
  return 'cursor-cli';
};
