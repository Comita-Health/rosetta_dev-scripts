import { injectable } from 'inversify';
import { WorkflowError } from '../types';
import type { IModelRepository } from './model.repository';

const DEFAULT_BASE_URL = 'https://api.openai.com';
const DEFAULT_MODEL = 'gpt-5.6';

interface ResponsesOutputText {
  type: string;
  text?: string;
}

interface ResponsesOutputItem {
  type: string;
  content?: ResponsesOutputText[];
}

interface ResponsesResponse {
  output: ResponsesOutputItem[];
}

/**
 * Completion transport for the OpenAI Responses API (the recommended
 * surface for new integrations; Chat Completions remains their legacy
 * shape). `OPENAI_BASE_URL` supports OpenAI-compatible gateways.
 */
@injectable()
export class OpenAiRepository implements IModelRepository {
  async complete(prompt: string): Promise<string> {
    const apiKey = process.env.OPENAI_API_KEY;
    if (apiKey === undefined || apiKey.length === 0) {
      throw new WorkflowError(
        'OPENAI_API_KEY is not set (required for the openai backend)',
        'MISSING_API_KEY'
      );
    }

    const baseUrl = process.env.OPENAI_BASE_URL ?? DEFAULT_BASE_URL;
    const response = await fetch(`${baseUrl}/v1/responses`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL ?? DEFAULT_MODEL,
        input: prompt,
        store: false
      })
    });

    if (!response.ok) {
      const body = await response.text();
      throw new WorkflowError(
        `OpenAI API request failed (${response.status})`,
        'INFERENCE_FAILED',
        [body.slice(0, 500)]
      );
    }

    const payload = (await response.json()) as ResponsesResponse;
    const text = payload.output
      .filter(item => item.type === 'message' && item.content !== undefined)
      .flatMap(item => item.content ?? [])
      .filter(part => part.type === 'output_text' && part.text !== undefined)
      .map(part => part.text)
      .join('');

    if (text.length === 0) {
      throw new WorkflowError(
        'OpenAI API returned an empty response',
        'INFERENCE_FAILED'
      );
    }
    return text;
  }
}
