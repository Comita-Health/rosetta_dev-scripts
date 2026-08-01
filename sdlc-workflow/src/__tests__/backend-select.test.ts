import { resolveInferenceBackend } from '../utils/backend-select';

describe('resolveInferenceBackend', () => {
  it('resolves anthropic when ANTHROPIC_API_KEY is set', () => {
    expect(resolveInferenceBackend({ ANTHROPIC_API_KEY: 'sk-x' })).toBe(
      'anthropic'
    );
  });

  it('resolves openai when only OPENAI_API_KEY is set', () => {
    expect(resolveInferenceBackend({ OPENAI_API_KEY: 'sk-o' })).toBe('openai');
  });

  it('prefers anthropic when both API keys are set', () => {
    expect(
      resolveInferenceBackend({
        ANTHROPIC_API_KEY: 'sk-a',
        OPENAI_API_KEY: 'sk-o'
      })
    ).toBe('anthropic');
  });

  it('resolves cursor-cli when no key is present', () => {
    expect(resolveInferenceBackend({})).toBe('cursor-cli');
    expect(
      resolveInferenceBackend({ ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '' })
    ).toBe('cursor-cli');
  });

  it('honours the explicit SDLC_INFERENCE_BACKEND override', () => {
    expect(
      resolveInferenceBackend({
        SDLC_INFERENCE_BACKEND: 'cursor-cli',
        ANTHROPIC_API_KEY: 'sk-x'
      })
    ).toBe('cursor-cli');
    expect(
      resolveInferenceBackend({ SDLC_INFERENCE_BACKEND: 'anthropic' })
    ).toBe('anthropic');
    expect(
      resolveInferenceBackend({
        SDLC_INFERENCE_BACKEND: 'openai',
        ANTHROPIC_API_KEY: 'sk-a'
      })
    ).toBe('openai');
  });

  it('rejects unknown backend values with a typed error', () => {
    expect(() =>
      resolveInferenceBackend({ SDLC_INFERENCE_BACKEND: 'gemini' })
    ).toThrow(
      expect.objectContaining({
        name: 'WorkflowError',
        code: 'INVALID_BACKEND'
      })
    );
  });

  it('treats an empty override as unset', () => {
    expect(resolveInferenceBackend({ SDLC_INFERENCE_BACKEND: '' })).toBe(
      'cursor-cli'
    );
  });
});
