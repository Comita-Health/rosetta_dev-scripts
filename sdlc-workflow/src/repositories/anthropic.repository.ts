import { injectable } from 'inversify';
import { WorkflowError } from '../types';

export interface IAnthropicRepository {
  complete(prompt: string): Promise<string>;
}

const API_URL = 'https://api.anthropic.com/v1/messages';
const DEFAULT_MODEL = 'claude-sonnet-4-5';
const MAX_TOKENS = 8192;

interface MessagesResponse {
  content: Array<{ type: string; text?: string }>;
}

@injectable()
export class AnthropicRepository implements IAnthropicRepository {
  async complete(prompt: string): Promise<string> {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new WorkflowError(
        'ANTHROPIC_API_KEY is not set (required per ADR-0003 / PRD-0011 §5)',
        'MISSING_API_KEY'
      );
    }

    const response = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: process.env.ANTHROPIC_MODEL ?? DEFAULT_MODEL,
        max_tokens: MAX_TOKENS,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!response.ok) {
      const body = await response.text();
      throw new WorkflowError(
        `Anthropic API request failed (${response.status})`,
        'INFERENCE_FAILED',
        [body.slice(0, 500)]
      );
    }

    const payload = (await response.json()) as MessagesResponse;
    const text = payload.content
      .filter(block => block.type === 'text' && block.text !== undefined)
      .map(block => block.text)
      .join('');

    if (text.length === 0) {
      throw new WorkflowError(
        'Anthropic API returned an empty response',
        'INFERENCE_FAILED'
      );
    }
    return text;
  }
}
