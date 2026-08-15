import {
  DEFAULT_HALT_MULTIPLIER,
  budgetHaltDetail,
  haltAtBudgetK,
  isBudgetHalt
} from '../utils/budget-halt';

describe('budget-halt (PRD-0026)', () => {
  it('halts at 3× budgetK and not below', () => {
    expect(DEFAULT_HALT_MULTIPLIER).toBe(3);
    expect(haltAtBudgetK(200)).toBe(600);
    expect(isBudgetHalt(599, 200)).toBe(false);
    expect(isBudgetHalt(600, 200)).toBe(true);
    expect(isBudgetHalt(250, 200)).toBe(false);
  });

  it('names the multiplier in the halt detail', () => {
    expect(budgetHaltDetail(600, 200)).toContain('3× budget 200k');
    expect(budgetHaltDetail(600, 200)).toContain('halt 600k');
  });
});
