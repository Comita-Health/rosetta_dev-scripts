import { WorkflowError } from '../types';

export type InferenceBackend = 'anthropic' | 'cursor-cli';

/**
 * Select the completion transport (SPEC-PRD-0011-P1 T-03):
 * `SDLC_INFERENCE_BACKEND` wins when set; otherwise `anthropic` when
 * `ANTHROPIC_API_KEY` is present, else the operator's `cursor-agent`
 * session.
 */
export const resolveInferenceBackend = (
  env: NodeJS.ProcessEnv
): InferenceBackend => {
  const explicit = env.SDLC_INFERENCE_BACKEND;
  if (explicit === 'anthropic' || explicit === 'cursor-cli') {
    return explicit;
  }
  if (explicit !== undefined && explicit.length > 0) {
    throw new WorkflowError(
      `Unknown SDLC_INFERENCE_BACKEND "${explicit}" — expected "anthropic" or "cursor-cli"`,
      'INVALID_BACKEND'
    );
  }
  const apiKey = env.ANTHROPIC_API_KEY;
  return apiKey !== undefined && apiKey.length > 0 ? 'anthropic' : 'cursor-cli';
};
