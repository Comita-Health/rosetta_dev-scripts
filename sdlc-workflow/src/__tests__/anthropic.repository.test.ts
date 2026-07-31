import 'reflect-metadata';
import { AnthropicRepository } from '../repositories/anthropic.repository';

describe('AnthropicRepository', () => {
  const repo = new AnthropicRepository();
  const originalFetch = global.fetch;
  const originalKey = process.env.ANTHROPIC_API_KEY;

  afterEach(() => {
    global.fetch = originalFetch;
    if (originalKey === undefined) {
      delete process.env.ANTHROPIC_API_KEY;
    } else {
      process.env.ANTHROPIC_API_KEY = originalKey;
    }
  });

  it('fails typed when ANTHROPIC_API_KEY is missing', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    await expect(repo.complete('hi')).rejects.toMatchObject({
      code: 'MISSING_API_KEY'
    });
  });

  it('joins text blocks from a successful response', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        content: [
          { type: 'text', text: 'hello ' },
          { type: 'tool_use' },
          { type: 'text', text: 'world' }
        ]
      })
    }) as unknown as typeof fetch;

    await expect(repo.complete('hi')).resolves.toBe('hello world');
    const [url, init] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toContain('api.anthropic.com');
    expect(init.headers['x-api-key']).toBe('test-key');
  });

  it('fails typed on a non-200 response', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 429,
      text: async () => 'rate limited'
    }) as unknown as typeof fetch;

    await expect(repo.complete('hi')).rejects.toMatchObject({
      code: 'INFERENCE_FAILED',
      details: ['rate limited']
    });
  });

  it('fails typed on an empty response', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ content: [] })
    }) as unknown as typeof fetch;

    await expect(repo.complete('hi')).rejects.toMatchObject({
      code: 'INFERENCE_FAILED'
    });
  });
});
