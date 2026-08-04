import { SpecDocument, WorkflowError, WorkflowErrorCode } from '../types';
import { parseSpec } from './spec-parser';

/**
 * Verification tiers recognized on an acceptance-criterion checkbox. The
 * runtime verifier ({@link parseCriterionTier}) only executes test/agent/manual,
 * but Approved specs on this repo also carry `docs:` criteria (closed by the
 * docs PR, not the machine), so the format lint must recognize the full set —
 * a lint that rejects a real Approved spec is worse than no lint.
 */
export const RECOGNIZED_TIERS = ['test', 'agent', 'manual', 'docs'] as const;

const TIER_TAG = new RegExp(`^(?:${RECOGNIZED_TIERS.join('|')}):\\s+\\S`);

/**
 * An envelope array entry is a single glob or surface label. After the parser
 * unwraps the flow array it should be a clean token — no whitespace, quote
 * characters, or stray brackets. Those are the fingerprints of a formatter (or
 * hand-edit) reshaping the inline array into a form the tolerant parser silently
 * mis-joins (the Prettier incident): e.g. a YAML block sequence collapses to a
 * single garbage glob `- 'src/**' - 'README.md`, and the envelope silently
 * stops guarding anything. spec-lint is the pre-intake guard that names it.
 */
const RESHAPED_ENTRY = /[\s'"[\]]/;

export interface SpecLintFinding {
  /** A named WorkflowError code, so hooks/CI can branch on the failure class. */
  code: WorkflowErrorCode;
  message: string;
}

export interface SpecLintReport {
  ok: boolean;
  specId?: string;
  status?: string;
  taskCount: number;
  criterionCount: number;
  findings: SpecLintFinding[];
}

const lintEnvelope = (doc: SpecDocument, findings: SpecLintFinding[]): void => {
  const { envelope } = doc;

  if (envelope.allowedPaths.length === 0) {
    findings.push({
      code: 'SPEC_INVALID',
      message: 'envelope: allowedPaths must not be empty'
    });
  }
  if (!Number.isFinite(envelope.maxDiffLines) || envelope.maxDiffLines <= 0) {
    findings.push({
      code: 'SPEC_INVALID',
      message: `envelope: maxDiffLines must be a positive number (got "${envelope.maxDiffLines}")`
    });
  }
  if (!Number.isFinite(envelope.budgetK) || envelope.budgetK <= 0) {
    findings.push({
      code: 'SPEC_INVALID',
      message: `envelope: budgetK must be a positive number (got "${envelope.budgetK}")`
    });
  }

  const arrays: Array<[keyof typeof envelope, string[]]> = [
    ['allowedPaths', envelope.allowedPaths],
    ['forbiddenSurfaces', envelope.forbiddenSurfaces]
  ];
  for (const [field, entries] of arrays) {
    for (const entry of entries) {
      if (RESHAPED_ENTRY.test(entry)) {
        findings.push({
          code: 'SPEC_MALFORMED',
          message:
            `envelope: ${String(field)} entry "${entry}" looks reshaped by a ` +
            `formatter (whitespace/quote/bracket in a glob) — run the ` +
            `envelope through spec-lint before intake`
        });
      }
    }
  }
};

const lintCheckboxes = (
  doc: SpecDocument,
  findings: SpecLintFinding[]
): number => {
  const taskIds = new Set(doc.tasks.map(t => t.id));
  let criterionCount = 0;

  for (const task of doc.tasks) {
    if (task.acceptanceCriteria.length === 0) {
      findings.push({
        code: 'SPEC_INVALID',
        message: `Task ${task.id}: no acceptance criteria`
      });
    }
    for (const criterion of task.acceptanceCriteria) {
      criterionCount += 1;
      if (!TIER_TAG.test(criterion.trim())) {
        findings.push({
          code: 'SPEC_MALFORMED',
          message:
            `Task ${task.id}: criterion "${criterion.slice(0, 80)}" has a ` +
            `missing or unrecognized verification-tier tag (expected ` +
            `${RECOGNIZED_TIERS.map(t => `${t}:`).join(' | ')})`
        });
      }
    }
    for (const dep of task.dependsOn) {
      if (!taskIds.has(dep)) {
        findings.push({
          code: 'SPEC_INVALID',
          message: `Task ${task.id}: depends on unknown task "${dep}"`
        });
      }
    }
  }

  return criterionCount;
};

/**
 * Lint an ADR-0008 implementation spec's Markdown. Three integrity layers, each
 * reporting a named error class: (1) front-matter / structure parse, (2) envelope
 * schema + inline-array integrity, (3) checkbox integrity — every criterion
 * present and carrying a recognized tier. Usable from a pre-commit hook or CI to
 * catch a formatter-reshaped envelope before intake silently does.
 */
export const lintSpec = (markdown: string): SpecLintReport => {
  let doc: SpecDocument;
  try {
    doc = parseSpec(markdown);
  } catch (err) {
    if (err instanceof WorkflowError) {
      return {
        ok: false,
        taskCount: 0,
        criterionCount: 0,
        findings: [{ code: err.code, message: err.message }]
      };
    }
    throw err;
  }

  const findings: SpecLintFinding[] = [];
  lintEnvelope(doc, findings);
  const criterionCount = lintCheckboxes(doc, findings);

  return {
    ok: findings.length === 0,
    specId: doc.id,
    status: doc.status,
    taskCount: doc.tasks.length,
    criterionCount,
    findings
  };
};
