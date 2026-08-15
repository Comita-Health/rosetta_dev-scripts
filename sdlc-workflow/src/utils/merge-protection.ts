/**
 * Classify a failed `gh pr merge` as "branch protection still requires a
 * person" (PRD-0026 Phase 3). Fail loud with this diagnosis instead of
 * spinning retries.
 */
export const isHumanReviewRequired = (message: string): boolean =>
  /review required|required reviewing|at least \d+ approving|pull request reviews?|codeowners|changes must be approved|reviews from|waiting on code owner/i.test(
    message
  );
