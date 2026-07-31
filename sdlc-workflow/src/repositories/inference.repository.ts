import { inject, injectable } from 'inversify';
import { WORKFLOW_TOKENS } from '../tokens';
import { WorkflowError } from '../types';
import { extractJson, JsonSchema, validateJson } from '../utils/json-schema';
import type { IModelRepository } from './model.repository';

export interface IInferenceRepository {
  /**
   * Run a prompt and return JSON validated against `schema`. Retries exactly
   * once on schema-invalid output (quoting the violations back to the model),
   * then fails with a typed error carrying the validation failure.
   */
  generateJson<T>(prompt: string, schema: JsonSchema): Promise<T>;
}

const jsonInstructions = (schema: JsonSchema): string =>
  [
    '',
    'Respond with a single JSON object only — no prose, no markdown fence.',
    'It must conform to this JSON schema:',
    JSON.stringify(schema, null, 2)
  ].join('\n');

@injectable()
export class InferenceRepository implements IInferenceRepository {
  constructor(
    @inject(WORKFLOW_TOKENS.ModelRepository)
    private readonly _model: IModelRepository
  ) {}

  async generateJson<T>(prompt: string, schema: JsonSchema): Promise<T> {
    let lastErrors: string[] = [];
    let currentPrompt = prompt + jsonInstructions(schema);

    for (let attempt = 0; attempt < 2; attempt++) {
      const raw = await this._model.complete(currentPrompt);

      let parsed: unknown;
      try {
        parsed = extractJson(raw);
      } catch (err) {
        lastErrors = [err instanceof Error ? err.message : String(err)];
        currentPrompt =
          prompt +
          jsonInstructions(schema) +
          `\n\nYour previous response was not parseable JSON (${lastErrors[0]}). Respond again with valid JSON only.`;
        continue;
      }

      const violations = validateJson(schema, parsed);
      if (violations.length === 0) {
        return parsed as T;
      }
      lastErrors = violations;
      currentPrompt =
        prompt +
        jsonInstructions(schema) +
        '\n\nYour previous response violated the schema:\n' +
        violations.map(v => `- ${v}`).join('\n') +
        '\nRespond again with corrected JSON only.';
    }

    throw new WorkflowError(
      'Model output failed schema validation after one retry',
      'INFERENCE_INVALID',
      lastErrors
    );
  }
}
