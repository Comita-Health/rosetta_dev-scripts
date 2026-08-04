import { inject, injectable } from 'inversify';
import type { IGitRepository } from '../repositories/git.repository';
import type { IInferenceRepository } from '../repositories/inference.repository';
import type { IReviewChecklistRepository } from '../repositories/review-checklist.repository';
import { WORKFLOW_TOKENS } from '../tokens';
import {
  Envelope,
  GateVerdict,
  ReviewChecklist,
  ReviewerAssessment,
  SpecTask
} from '../types';
import { JsonSchema } from '../utils/json-schema';
import { buildReviewerPrompt } from '../utils/reviewer-prompt';

export interface ReviewerGateInput {
  repoPath: string;
  baseRef: string;
  headRef: string;
  task: SpecTask;
  envelope: Envelope;
}

/**
 * SPEC-PRD-0011-P2 T-05: an independent reviewer agent — no shared context
 * with the implementation agent — reviews the task diff against the spec
 * task and envelope, returning concur or disagree with cited reasons.
 * Shadow semantics: disagreement is recorded with `wouldEscalate`, never
 * blocking. The full assessment is persisted verbatim as the verdict
 * transcript (S-05).
 *
 * T-01: when the repo declares `.sdlc/review-checklist.md`, the prompt
 * includes it and the schema gains per-item `checklistFindings`; a failed
 * `mandatory` item overrides a model concur to disagree. No checklist →
 * unchanged pre-checklist prompt/verdict shape.
 */
export interface IReviewerGateService {
  review(input: ReviewerGateInput): Promise<GateVerdict>;
}

const ASSESSMENT_SCHEMA: JsonSchema = {
  type: 'object',
  required: ['decision', 'reasons'],
  properties: {
    decision: { type: 'string', enum: ['concur', 'disagree'] },
    reasons: { type: 'array', items: { type: 'string' } }
  }
};

const CHECKLIST_FINDING_SCHEMA: JsonSchema = {
  type: 'object',
  required: ['itemIndex', 'item', 'outcome'],
  properties: {
    itemIndex: { type: 'number' },
    item: { type: 'string' },
    outcome: { type: 'string', enum: ['pass', 'fail'] },
    rationale: { type: 'string' }
  }
};

/** Extends the base schema with `checklistFindings` — one entry per item. */
const buildAssessmentSchema = (checklist: ReviewChecklist): JsonSchema => ({
  ...ASSESSMENT_SCHEMA,
  required: [...(ASSESSMENT_SCHEMA.required ?? []), 'checklistFindings'],
  properties: {
    ...ASSESSMENT_SCHEMA.properties,
    checklistFindings: {
      type: 'array',
      minItems: checklist.items.length,
      items: CHECKLIST_FINDING_SCHEMA
    }
  }
});

/** Findings naming a checklist item marked mandatory that came back failing. */
const failedMandatoryFindings = (
  checklist: ReviewChecklist,
  findings: ReviewerAssessment['checklistFindings']
) =>
  (findings ?? []).filter(finding => {
    const item = checklist.items[finding.itemIndex - 1];
    return item?.mandatory === true && finding.outcome === 'fail';
  });

@injectable()
export class ReviewerGateService implements IReviewerGateService {
  constructor(
    @inject(WORKFLOW_TOKENS.GitRepository)
    private readonly _gitRepo: IGitRepository,
    @inject(WORKFLOW_TOKENS.InferenceRepository)
    private readonly _inference: IInferenceRepository,
    @inject(WORKFLOW_TOKENS.ReviewChecklistRepository)
    private readonly _checklistRepo: IReviewChecklistRepository
  ) {}

  async review(input: ReviewerGateInput): Promise<GateVerdict> {
    const diff = this._gitRepo.diffText(
      input.repoPath,
      input.baseRef,
      input.headRef
    );
    // Judged-tree read (T-03 tree-resolution rule), never local disk.
    const checklist = this._checklistRepo.loadAtRef(
      input.repoPath,
      input.headRef
    );
    const prompt = buildReviewerPrompt(
      input.task,
      input.envelope,
      diff,
      checklist ?? undefined
    );
    const schema = checklist
      ? buildAssessmentSchema(checklist)
      : ASSESSMENT_SCHEMA;
    const assessment = await this._inference.generateJson<ReviewerAssessment>(
      prompt,
      schema
    );

    const mandatoryFailures = checklist
      ? failedMandatoryFindings(checklist, assessment.checklistFindings)
      : [];
    // Only an explicit concur passes, and even that is overridden by a
    // failed mandatory checklist item — no code path turns a disagreement
    // (model- or checklist-derived) into an approval.
    const concurs =
      assessment.decision === 'concur' && mandatoryFailures.length === 0;
    const reasons = [
      ...assessment.reasons,
      ...mandatoryFailures.map(
        f =>
          `mandatory checklist item failed: ${f.item}` +
          (f.rationale ? ` — ${f.rationale}` : '')
      )
    ];

    return {
      gate: 'reviewer',
      outcome: concurs ? 'pass' : 'breach',
      wouldEscalate: !concurs,
      reasons,
      transcript: JSON.stringify(assessment, null, 2),
      ...(checklist ? { checklistFindings: assessment.checklistFindings } : {}),
      recordedAt: new Date().toISOString()
    };
  }
}
