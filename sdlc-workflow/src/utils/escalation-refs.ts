import type { GateVerdict, RunState, SandboxRecord } from '../types';

/** Same `runs://` scheme as {@link evidenceLink} in digest.service — kept here
 * so utils do not import services. */
const evidenceHref = (runId: string, evidenceId: string): string =>
  `runs://${runId}/evidence/${evidenceId}`;

/**
 * Actionable references attached to a needs-human escalation so the operator
 * can jump to the blocker without reconstructing run state by hand.
 */
export interface EscalationRefs {
  prUrl?: string;
  headSha?: string;
  branch?: string;
  specPath?: string;
  /** Criterion text for verification `human-required` outcomes. */
  humanRequired?: string[];
  /** Failed GitHub check runs with deep links (when the API returned URLs). */
  ciCheckUrls?: Array<{ name: string; url: string }>;
  sandbox?: {
    sha?: string;
    status?: string;
    evidenceId?: string;
  };
}

const HUMAN_REQUIRED_PREFIX = 'human required: ';

/**
 * Latest gate verdict for `taskId` + `gate` by `recordedAt` (tie → last in
 * array order). Absent when the task never recorded that gate.
 */
export const latestTaskVerdict = (
  state: RunState,
  taskId: string,
  gate: string
): GateVerdict | undefined => {
  const matches = state.verdicts.filter(
    verdict => verdict.taskId === taskId && verdict.gate === gate
  );
  if (matches.length === 0) {
    return undefined;
  }
  return matches.reduce((best, verdict) =>
    verdict.recordedAt >= best.recordedAt ? verdict : best
  );
};

/**
 * Pull human-required criterion lines from a verification verdict's reasons.
 */
export const humanRequiredCriteria = (
  verdict: GateVerdict | undefined
): string[] => {
  if (verdict === undefined) {
    return [];
  }
  return verdict.reasons
    .filter(reason => reason.startsWith(HUMAN_REQUIRED_PREFIX))
    .map(reason => reason.slice(HUMAN_REQUIRED_PREFIX.length).trim())
    .filter(text => text.length > 0);
};

const sandboxEvidenceId = (
  state: RunState,
  taskId: string
): string | undefined => {
  const verdict = latestTaskVerdict(state, taskId, 'sandbox');
  const fromVerdict = verdict?.evidenceIds?.find(id =>
    id.endsWith('-sandbox-health')
  );
  if (fromVerdict !== undefined) {
    return fromVerdict;
  }
  const fallback = `${taskId}-sandbox-health`;
  const any = state.verdicts.some(
    verdict =>
      verdict.taskId === taskId &&
      (verdict.evidenceIds ?? []).includes(fallback)
  );
  return any ? fallback : undefined;
};

const sandboxRef = (
  state: RunState,
  taskId: string
): EscalationRefs['sandbox'] | undefined => {
  const record: SandboxRecord | undefined = state.sandbox;
  const evidenceId = sandboxEvidenceId(state, taskId);
  if (record === undefined && evidenceId === undefined) {
    return undefined;
  }
  return {
    ...(record?.sha !== undefined && record.sha.length > 0
      ? { sha: record.sha }
      : {}),
    ...(record?.status !== undefined ? { status: record.status } : {}),
    ...(evidenceId !== undefined ? { evidenceId } : {})
  };
};

/**
 * Collect operator-facing references for a task escalation from run state.
 *
 * @remarks
 * Pure — does not call `gh`. CI deep links are supplied by the caller when
 * available (from {@link ICiStatusRepository.checkRuns}).
 */
export const collectEscalationRefs = (input: {
  state: RunState;
  taskId: string;
  headSha?: string;
  ciCheckUrls?: Array<{ name: string; url: string }>;
}): EscalationRefs => {
  const task = input.state.taskResults[input.taskId];
  const verification = latestTaskVerdict(
    input.state,
    input.taskId,
    'verification'
  );
  const humanRequired = humanRequiredCriteria(verification);
  const sandbox = sandboxRef(input.state, input.taskId);
  const refs: EscalationRefs = {};

  if (task?.prUrl !== undefined && task.prUrl.length > 0) {
    refs.prUrl = task.prUrl;
  }
  if (input.headSha !== undefined && input.headSha.length > 0) {
    refs.headSha = input.headSha;
  }
  if (task?.branch !== undefined && task.branch.length > 0) {
    refs.branch = task.branch;
  }
  if (input.state.specPath.length > 0) {
    refs.specPath = input.state.specPath;
  }
  if (humanRequired.length > 0) {
    refs.humanRequired = humanRequired;
  }
  if (input.ciCheckUrls !== undefined && input.ciCheckUrls.length > 0) {
    refs.ciCheckUrls = input.ciCheckUrls;
  }
  if (sandbox !== undefined) {
    refs.sandbox = sandbox;
  }
  return refs;
};

/**
 * Markdown blocks for the needs-human issue body (excluding the Evidence
 * list, which still uses the flat evidence-id list).
 */
export const formatEscalationRefLines = (
  runId: string,
  refs: EscalationRefs
): string[] => {
  const lines: string[] = [];
  if (refs.prUrl !== undefined) {
    lines.push(`- **Blocker PR:** ${refs.prUrl}`);
  }
  if (refs.branch !== undefined) {
    lines.push(`- **Branch:** \`${refs.branch}\``);
  }
  if (refs.headSha !== undefined) {
    lines.push(`- **Head:** \`${refs.headSha}\``);
  }
  if (refs.specPath !== undefined) {
    lines.push(`- **Spec:** \`${refs.specPath}\``);
  }

  if (refs.humanRequired !== undefined && refs.humanRequired.length > 0) {
    lines.push('', '### Human-required criteria');
    for (const criterion of refs.humanRequired) {
      lines.push(`- ${criterion}`);
    }
  }

  if (refs.ciCheckUrls !== undefined && refs.ciCheckUrls.length > 0) {
    lines.push('', '### CI');
    for (const check of refs.ciCheckUrls) {
      lines.push(`- [${check.name}](${check.url})`);
    }
  }

  if (refs.sandbox !== undefined) {
    const parts: string[] = [];
    if (refs.sandbox.sha !== undefined) {
      parts.push(`sha=\`${refs.sandbox.sha}\``);
    }
    if (refs.sandbox.status !== undefined) {
      parts.push(`status=\`${refs.sandbox.status}\``);
    }
    lines.push('', '### Sandbox');
    if (parts.length > 0) {
      lines.push(`- ${parts.join(' · ')}`);
    }
    if (refs.sandbox.evidenceId !== undefined) {
      lines.push(
        `- evidence: \`${evidenceHref(runId, refs.sandbox.evidenceId)}\``
      );
    }
  }

  return lines;
};
