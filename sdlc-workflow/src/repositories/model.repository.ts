/**
 * Raw completion transport contract shared by the inference backends
 * (SPEC-PRD-0011-P1 T-03): `AnthropicRepository` (direct API via
 * `ANTHROPIC_API_KEY`) and `CursorCliRepository` (the operator's
 * authenticated `cursor-agent` session). The composition root selects one
 * via `resolveInferenceBackend` and binds it to
 * `WORKFLOW_TOKENS.ModelRepository`.
 */
export interface IModelRepository {
  complete(prompt: string): Promise<string>;
}
