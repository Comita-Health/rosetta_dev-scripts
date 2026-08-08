import path from 'path';
import type { GateVerdict, RunState, SandboxRecord } from '../types';

/** Same `runs://` scheme as {@link evidenceLink} in digest.service — kept here
 * so utils do not import services. Local/engine URI; not a browser URL. */
const evidenceHref = (runId: string, evidenceId: string): string =>
  `runs://${runId}/evidence/${evidenceId}`;

/**
 * Actionable references attached to a needs-human escalation so the operator
 * can jump to the blocker without reconstructing run state by hand.
 */
export interface EscalationRefs {
  /** `owner/repo` for GitHub deep links (from the task checkout's origin). */
  repoSlug?: string;
  /** Absolute checkout path — used to relativize `specPath` for blob URLs. */
  repoPath?: string;
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

/** Repo-relative paths worth auto-linking inside freeform criterion text. */
const REPO_PATH_IN_TEXT =
  /(?<![[`/])((?:specs|sdlc-workflow|docs)\/[\w./-]+\.(?:md|ts|tsx|js|mjs|cjs|json|ya?ml))(?![`)\]])/g;

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
 * Turn an absolute or relative file path into a POSIX repo-relative path for
 * `blob/` URLs. Returns undefined when the path cannot be placed under the
 * checkout (outside the repo, or absolute with no recognizable `specs/` /
 * `sdlc-workflow/` / `docs/` suffix).
 */
export const repoRelativePath = (
  filePath: string,
  repoPath?: string
): string | undefined => {
  if (filePath.length === 0) {
    return undefined;
  }
  if (repoPath !== undefined && repoPath.length > 0) {
    const rel = path.relative(repoPath, filePath);
    if (
      rel.length > 0 &&
      !rel.startsWith(`..${path.sep}`) &&
      rel !== '..' &&
      !path.isAbsolute(rel)
    ) {
      return rel.split(path.sep).join('/');
    }
  }
  if (!path.isAbsolute(filePath)) {
    return filePath.split(path.sep).join('/');
  }
  const match = /(?:^|\/)((?:specs|sdlc-workflow|docs)\/.+)$/.exec(filePath);
  return match?.[1];
};

/** GitHub web base for an `owner/repo` slug. */
export const githubRepoUrl = (repoSlug: string): string =>
  `https://github.com/${repoSlug}`;

export const githubCommitUrl = (repoSlug: string, sha: string): string =>
  `${githubRepoUrl(repoSlug)}/commit/${sha}`;

export const githubTreeUrl = (repoSlug: string, branch: string): string =>
  `${githubRepoUrl(repoSlug)}/tree/${branch
    .split('/')
    .map(segment => encodeURIComponent(segment))
    .join('/')}`;

export const githubBlobUrl = (
  repoSlug: string,
  ref: string,
  repoRelPath: string
): string => {
  const refEncoded = ref
    .split('/')
    .map(segment => encodeURIComponent(segment))
    .join('/');
  const pathEncoded = repoRelPath
    .split('/')
    .map(segment => encodeURIComponent(segment))
    .join('/');
  return `${githubRepoUrl(repoSlug)}/blob/${refEncoded}/${pathEncoded}`;
};

const mdCodeLink = (label: string, url: string): string =>
  `[\`${label}\`](${url})`;

/**
 * Prefer the task head SHA for permalinks; fall back to the task branch.
 */
export const blobRef = (refs: EscalationRefs): string | undefined => {
  if (refs.headSha !== undefined && refs.headSha.length > 0) {
    return refs.headSha;
  }
  if (refs.branch !== undefined && refs.branch.length > 0) {
    return refs.branch;
  }
  return undefined;
};

/**
 * Replace recognizable repo-relative paths in freeform criterion text with
 * markdown blob links when `repoSlug` + a ref are available.
 */
export const linkifyRepoPathsInText = (
  text: string,
  repoSlug: string | undefined,
  ref: string | undefined
): string => {
  if (repoSlug === undefined || ref === undefined) {
    return text;
  }
  return text.replace(REPO_PATH_IN_TEXT, (matched, pathMatch: string) =>
    mdCodeLink(pathMatch, githubBlobUrl(repoSlug, ref, pathMatch))
  );
};

/**
 * Collect operator-facing references for a task escalation from run state.
 *
 * @remarks
 * Pure — does not call `gh`. CI deep links are supplied by the caller when
 * available (from {@link ICiStatusRepository.checkRuns}). Pass `repoSlug`
 * (and optionally `repoPath`) so issue bodies can emit clickable GitHub
 * tree/commit/blob URLs.
 */
export const collectEscalationRefs = (input: {
  state: RunState;
  taskId: string;
  headSha?: string;
  ciCheckUrls?: Array<{ name: string; url: string }>;
  repoSlug?: string;
  repoPath?: string;
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

  if (input.repoSlug !== undefined && input.repoSlug.length > 0) {
    refs.repoSlug = input.repoSlug;
  }
  if (input.repoPath !== undefined && input.repoPath.length > 0) {
    refs.repoPath = input.repoPath;
  }
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
 *
 * @remarks
 * When `repoSlug` is set, Branch / Head / Spec / sandbox SHA become GitHub
 * markdown links (`tree` / `commit` / `blob`). `runs://…` evidence stays
 * monospace — that scheme is local engine evidence, not a browser URL.
 */
export const formatEscalationRefLines = (
  runId: string,
  refs: EscalationRefs
): string[] => {
  const lines: string[] = [];
  const slug = refs.repoSlug;
  const ref = blobRef(refs);

  if (refs.prUrl !== undefined) {
    lines.push(`- **Blocker PR:** ${refs.prUrl}`);
  }
  if (refs.branch !== undefined) {
    const branchLabel =
      slug !== undefined
        ? mdCodeLink(refs.branch, githubTreeUrl(slug, refs.branch))
        : `\`${refs.branch}\``;
    lines.push(`- **Branch:** ${branchLabel}`);
  }
  if (refs.headSha !== undefined) {
    const headLabel =
      slug !== undefined
        ? mdCodeLink(refs.headSha, githubCommitUrl(slug, refs.headSha))
        : `\`${refs.headSha}\``;
    lines.push(`- **Head:** ${headLabel}`);
  }
  if (refs.specPath !== undefined) {
    const rel = repoRelativePath(refs.specPath, refs.repoPath);
    const specLabel =
      slug !== undefined && rel !== undefined && ref !== undefined
        ? mdCodeLink(rel, githubBlobUrl(slug, ref, rel))
        : `\`${rel ?? refs.specPath}\``;
    lines.push(`- **Spec:** ${specLabel}`);
  }

  if (refs.humanRequired !== undefined && refs.humanRequired.length > 0) {
    lines.push('', '### Human-required criteria');
    for (const criterion of refs.humanRequired) {
      lines.push(`- ${linkifyRepoPathsInText(criterion, slug, ref)}`);
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
      const shaLabel =
        slug !== undefined
          ? mdCodeLink(
              refs.sandbox.sha,
              githubCommitUrl(slug, refs.sandbox.sha)
            )
          : `\`${refs.sandbox.sha}\``;
      parts.push(`sha=${shaLabel}`);
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
        `- evidence: \`${evidenceHref(runId, refs.sandbox.evidenceId)}\` _(local run evidence)_`
      );
    }
  }

  return lines;
};
