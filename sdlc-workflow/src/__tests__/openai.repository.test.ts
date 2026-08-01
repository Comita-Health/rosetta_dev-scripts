import 'reflect-metadata';
import { OpenAiRepository } from '../repositories/openai.repository';

describe('OpenAiRepository', () => {
  const repo = new OpenAiRepository();
  const originalFetch = global.fetch;
  const savedEnv: Record<string, string | undefined> = {};
  const ENV_KEYS = ['OPENAI_API_KEY', 'OPENAI_MODEL', 'OPENAI_BASE_URL'];

  beforeEach(() => {
    for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  });

  afterEach(() => {
    global.fetch = originalFetch;
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
  });

  it('fails typed when OPENAI_API_KEY is missing', async () => {
    delete process.env.OPENAI_API_KEY;
    await expect(repo.complete('hi')).rejects.toMatchObject({
      code: 'MISSING_API_KEY'
    });
  });

  it('joins output_text parts from message items', async () => {
    process.env.OPENAI_API_KEY = 'test-key';
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        output: [
          { type: 'reasoning', content: [] },
          {
            type: 'message',
            content: [
              { type: 'output_text', text: 'hello ' },
              { type: 'annotation' },
              { type: 'output_text', text: 'world' }
            ]
          }
        ]
      })
    }) as unknown as typeof fetch;

    await expect(repo.complete('hi')).resolves.toBe('hello world');
    const [url, init] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe('https://api.openai.com/v1/responses');
    expect(init.headers.authorization).toBe('Bearer test-key');
    const body = JSON.parse(init.body);
    expect(body.model).toBe('gpt-5.6');
    expect(body.input).toBe('hi');
    expect(body.store).toBe(false);
  });

  it('honours OPENAI_MODEL and OPENAI_BASE_URL overrides', async () => {
    process.env.OPENAI_API_KEY = 'test-key';
    process.env.OPENAI_MODEL = 'gpt-5.6-terra';
    process.env.OPENAI_BASE_URL = 'https://gateway.example.com';
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        output: [
          { type: 'message', content: [{ type: 'output_text', text: 'ok' }] }
        ]
      })
    }) as unknown as typeof fetch;

    await repo.complete('hi');
    const [url, init] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe('https://gateway.example.com/v1/responses');
    expect(JSON.parse(init.body).model).toBe('gpt-5.6-terra');
  });

  it('fails typed on a non-200 response', async () => {
    process.env.OPENAI_API_KEY = 'test-key';
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
    process.env.OPENAI_API_KEY = 'test-key';
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ output: [{ type: 'reasoning', content: [] }] })
    }) as unknown as typeof fetch;

    await expect(repo.complete('hi')).rejects.toMatchObject({
      code: 'INFERENCE_FAILED'
    });
  });
});
