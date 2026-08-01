import { agentSpendK } from '../utils/agent-spend';

describe('agentSpendK (P3 T-06)', () => {
  const original = process.env.SDLC_AGENT_SPEND_K;

  afterEach(() => {
    if (original === undefined) {
      delete process.env.SDLC_AGENT_SPEND_K;
    } else {
      process.env.SDLC_AGENT_SPEND_K = original;
    }
  });

  it('defaults to 5 when unset or empty', () => {
    delete process.env.SDLC_AGENT_SPEND_K;
    expect(agentSpendK()).toBe(5);
    process.env.SDLC_AGENT_SPEND_K = '';
    expect(agentSpendK()).toBe(5);
  });

  it('parses a non-negative override and rejects invalid values', () => {
    process.env.SDLC_AGENT_SPEND_K = '12';
    expect(agentSpendK()).toBe(12);
    process.env.SDLC_AGENT_SPEND_K = '0';
    expect(agentSpendK()).toBe(0);
    process.env.SDLC_AGENT_SPEND_K = '-1';
    expect(agentSpendK()).toBe(5);
    process.env.SDLC_AGENT_SPEND_K = 'nope';
    expect(agentSpendK()).toBe(5);
  });
});
