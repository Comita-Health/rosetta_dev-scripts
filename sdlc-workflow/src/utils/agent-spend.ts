/**
 * Estimated thousands of tokens charged per agent dispatch (P3 T-06).
 * Override via `SDLC_AGENT_SPEND_K` when a backend reports real usage.
 */
export const agentSpendK = (): number => {
  const raw = process.env.SDLC_AGENT_SPEND_K;
  if (raw === undefined || raw.length === 0) return 5;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 5;
};
