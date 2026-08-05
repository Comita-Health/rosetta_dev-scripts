import { NESTED_AGENT_ENV_KEYS, sanitizedAgentEnv } from '../utils/agent-env';

describe('sanitizedAgentEnv (SPEC-PRD-0021-P1 T-05)', () => {
  it('strips every nested-agent marker the orchestrator may be running under', () => {
    const base: NodeJS.ProcessEnv = { PATH: '/usr/bin' };
    for (const key of NESTED_AGENT_ENV_KEYS) base[key] = 'set-by-parent';

    const env = sanitizedAgentEnv(base);

    for (const key of NESTED_AGENT_ENV_KEYS) {
      // `undefined` is not enough: spawn's env is passed as-is to the child,
      // and a present-but-empty key still reads as "set" to a shell test.
      expect(Object.hasOwn(env, key)).toBe(false);
    }
    expect(env.PATH).toBe('/usr/bin');
  });

  it('names CURSOR_AGENT and the Claude Code marker explicitly', () => {
    // The spec calls out CURSOR_AGENT by name; the workspace is dual-tool, so
    // the Claude Code equivalent has to travel with it.
    expect(NESTED_AGENT_ENV_KEYS).toContain('CURSOR_AGENT');
    expect(NESTED_AGENT_ENV_KEYS).toContain('CLAUDECODE');
  });

  it('keeps the CURSOR_* variables the engine dispatches with', () => {
    const env = sanitizedAgentEnv({
      CURSOR_AGENT: '1',
      CURSOR_AGENT_BIN: '/opt/cursor-agent',
      CURSOR_MODEL: 'gpt-5.6-sol-medium',
      ANTHROPIC_API_KEY: 'sk-test'
    });

    // A `CURSOR_*` wildcard would have silently changed which binary and
    // model every dispatch used — a far quieter bug than the one being fixed.
    expect(env.CURSOR_AGENT_BIN).toBe('/opt/cursor-agent');
    expect(env.CURSOR_MODEL).toBe('gpt-5.6-sol-medium');
    expect(env.ANTHROPIC_API_KEY).toBe('sk-test');
    expect(env.CURSOR_AGENT).toBeUndefined();
  });

  it('does not mutate the environment it was given', () => {
    const base: NodeJS.ProcessEnv = { CURSOR_AGENT: '1' };

    sanitizedAgentEnv(base);

    // Mutating process.env here would sanitize the orchestrator itself and
    // change behaviour far outside the dispatch it was called for.
    expect(base.CURSOR_AGENT).toBe('1');
  });

  it('defaults to the live process environment', () => {
    process.env.CURSOR_AGENT = '1';
    process.env.SDLC_ENV_PROBE = 'kept';
    try {
      const env = sanitizedAgentEnv();

      expect(env.CURSOR_AGENT).toBeUndefined();
      expect(env.SDLC_ENV_PROBE).toBe('kept');
      expect(process.env.CURSOR_AGENT).toBe('1');
    } finally {
      delete process.env.CURSOR_AGENT;
      delete process.env.SDLC_ENV_PROBE;
    }
  });

  it('is a no-op when no marker is present', () => {
    expect(sanitizedAgentEnv({ PATH: '/bin', HOME: '/home/a' })).toEqual({
      PATH: '/bin',
      HOME: '/home/a'
    });
  });
});
