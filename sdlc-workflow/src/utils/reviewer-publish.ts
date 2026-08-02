import type { GateVerdict } from '../types';

/** Commit-status context for the sdlc-workflow reviewer gate. */
export const REVIEWER_STATUS_CONTEXT = 'sdlc/reviewer';

/** GitHub commit-status description max length. */
const STATUS_DESCRIPTION_MAX = 140;

/**
 * Parse a PR number from a GitHub pull URL, or null when the URL is missing /
 * not a pull URL.
 */
export const parsePrNumber = (prUrl: string | undefined): number | null => {
  if (prUrl === undefined || prUrl.length === 0) {
    return null;
  }
  const match = prUrl.match(/\/pull\/(\d+)(?:\/|$)/);
  if (match === null) {
    return null;
  }
  return Number(match[1]);
};

/** Truncate a status description to GitHub's limit. */
export const truncateStatusDescription = (text: string): string => {
  if (text.length <= STATUS_DESCRIPTION_MAX) {
    return text;
  }
  return `${text.slice(0, STATUS_DESCRIPTION_MAX - 1)}…`;
};

/**
 * Build the Markdown body posted to the task PR after the reviewer gate runs
 * (live-val follow-up: surface reviewer on the PR like Copilot overview).
 */
export const formatReviewerPrComment = (input: {
  runId: string;
  taskId: string;
  verdict: GateVerdict;
  shadow: boolean;
}): string => {
  const mode = input.shadow ? 'shadow' : 'enforce';
  const outcome = input.verdict.outcome;
  const headline =
    outcome === 'pass'
      ? 'pass (concur)'
      : outcome === 'breach'
        ? 'breach (disagree)'
        : outcome;
  const reasons =
    input.verdict.reasons.length === 0
      ? ['_(no reasons recorded)_']
      : input.verdict.reasons.map(reason => `- ${reason}`);
  const escalate =
    input.verdict.wouldEscalate === true
      ? '\n\nWould escalate under enforcement (`reviewer-disagreement`).'
      : '';

  return [
    `## sdlc-workflow reviewer (${mode})`,
    '',
    `**Task:** \`${input.taskId}\` · **Verdict:** **${headline}**`,
    `**Run:** \`${input.runId}\``,
    '',
    '### Reasons',
    ...reasons,
    escalate,
    '',
    `_Local evidence id: \`${input.taskId}-reviewer-transcript\` (run state / chronicle)._`
  ].join('\n');
};

/** Map a reviewer gate verdict to a commit-status state. */
export const reviewerStatusState = (
  outcome: GateVerdict['outcome']
): 'success' | 'failure' | 'error' => {
  if (outcome === 'pass') {
    return 'success';
  }
  if (outcome === 'breach') {
    return 'failure';
  }
  return 'error';
};
