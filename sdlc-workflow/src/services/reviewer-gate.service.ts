import { inject, injectable } from 'inversify';
import type { IGitRepository } from '../repositories/git.repository';
import type { IInferenceRepository } from '../repositories/inference.repository';
import { WORKFLOW_TOKENS } from '../tokens';
import { Envelope, GateVerdict, ReviewerAssessment, SpecTask } from '../types';
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
 * auto-resolved and never blocking. The full assessment is persisted
 * verbatim as the verdict transcript — it is the training signal gate
 * policy will consume (S-05).
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

@injectable()
export class ReviewerGateService implements IReviewerGateService {
  constructor(
    @inject(WORKFLOW_TOKENS.GitRepository)
    private readonly _gitRepo: IGitRepository,
    @inject(WORKFLOW_TOKENS.InferenceRepository)
    private readonly _inference: IInferenceRepository
  ) {}

  async review(input: ReviewerGateInput): Promise<GateVerdict> {
    const diff = this._gitRepo.diffText(
      input.repoPath,
      input.baseRef,
      input.headRef
    );
    const prompt = buildReviewerPrompt(input.task, input.envelope, diff);
    const assessment = await this._inference.generateJson<ReviewerAssessment>(
      prompt,
      ASSESSMENT_SCHEMA
    );

    // Only an explicit concur passes — there is no code path that turns a
    // disagreement into an approval.
    const concurs = assessment.decision === 'concur';
    return {
      gate: 'reviewer',
      outcome: concurs ? 'pass' : 'breach',
      wouldEscalate: !concurs,
      reasons: assessment.reasons,
      transcript: JSON.stringify(assessment, null, 2),
      recordedAt: new Date().toISOString()
    };
  }
}
