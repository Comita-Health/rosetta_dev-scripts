/**
 * PRD-0026: token `budgetK` is a signal. Halt new agent dispatches only
 * at `budgetK * haltMultiplier` (default 3). Spend below that is digest
 * material, not a stop.
 */
export const DEFAULT_HALT_MULTIPLIER = 3;

export const haltAtBudgetK = (
  budgetK: number,
  haltMultiplier = DEFAULT_HALT_MULTIPLIER
): number => budgetK * haltMultiplier;

/** True when spend has reached the halt threshold (at-or-above 3×). */
export const isBudgetHalt = (
  tokenSpendK: number,
  budgetK: number,
  haltMultiplier = DEFAULT_HALT_MULTIPLIER
): boolean => tokenSpendK >= haltAtBudgetK(budgetK, haltMultiplier);

export const budgetHaltDetail = (
  tokenSpendK: number,
  budgetK: number,
  haltMultiplier = DEFAULT_HALT_MULTIPLIER
): string =>
  `budget exhausted: spend ${tokenSpendK}k reaches halt ` +
  `${haltAtBudgetK(budgetK, haltMultiplier)}k ` +
  `(${haltMultiplier}× budget ${budgetK}k)`;
