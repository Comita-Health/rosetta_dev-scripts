import { CriterionTier, WorkflowError } from '../types';

const TIER_PATTERN = /^(test|agent|manual|docs):\s*(.*)$/;

export interface TieredCriterion {
  tier: CriterionTier;
  body: string;
  /** The original criterion text, prefix included. */
  raw: string;
}

/**
 * Parse one acceptance criterion by its ADR-0008 verification-tier prefix.
 * A missing or unknown prefix is a spec validation failure — thrown before
 * any execution begins (SPEC-PRD-0011-P2 T-04).
 *
 * @remarks
 * The recognized set must stay identical to `spec-lint`'s
 * {@link RECOGNIZED_TIERS}. It drifted once: the lint accepted `docs:` while
 * this threw on it, so a spec that passed intake crashed verification at the
 * first docs criterion — and, later, crashed closeout. `docs:` and `manual:`
 * both mean a human closes the criterion; neither is machine-executable.
 */
export const parseCriterionTier = (criterion: string): TieredCriterion => {
  const match = criterion.trim().match(TIER_PATTERN);
  if (!match) {
    throw new WorkflowError(
      `Acceptance criterion has a missing or unknown tier prefix (expected test: | agent: | manual: | docs:): "${criterion.slice(0, 80)}"`,
      'SPEC_MALFORMED'
    );
  }
  return {
    tier: match[1] as CriterionTier,
    body: match[2].trim(),
    raw: criterion.trim()
  };
};

/** Parse all criteria up front so validation completes before execution. */
export const parseAllCriteria = (criteria: string[]): TieredCriterion[] =>
  criteria.map(parseCriterionTier);
