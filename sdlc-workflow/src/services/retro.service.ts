import { inject, injectable } from 'inversify';
import type { IChronicleArtifactRepository } from '../repositories/chronicle-artifact.repository';
import type { IInferenceRepository } from '../repositories/inference.repository';
import type { IQueueRepository } from '../repositories/queue.repository';
import { WORKFLOW_TOKENS } from '../tokens';
import { ExceptionEntry, GateVerdict } from '../types';
import { JsonSchema } from '../utils/json-schema';
import { buildRetroPrompt } from '../utils/retro-prompt';

export interface RetroInput {
  chronicleRepo: string;
  runId: string;
  specId: string;
  /** The spec's "## Context" prose — symptom, repro, root cause. */
  context: string;
  verdicts: GateVerdict[];
  exceptions: ExceptionEntry[];
}

export interface RetroRecommendation {
  /** The pipeline stage that should own the earlier-catching check, e.g. 'envelope', 'reviewer'. */
  stage: string;
  check: string;
  rationale: string;
}

interface RetroAssessment {
  recommendations: RetroRecommendation[];
}

/** The `sdlc.retro.v1` artifact payload committed to the Chronicle. */
export interface SdlcRetro {
  schema: 'sdlc.retro.v1';
  runId: string;
  specId: string;
  recommendations: RetroRecommendation[];
  postedAt: string;
}

export interface RetroOutcome {
  retro: SdlcRetro;
  artifactPath: string;
  /** False when the queue already held this item (resume idempotency). */
  queueAppended: boolean;
}

/** SPEC-BUG-retro-and-queued-plans-P1 T-01: one retro inference call per completed `BUG-*` run. */
export interface IRetroService {
  /**
   * Runs inference over the run's Context/verdicts/exceptions, commits the
   * resulting `sdlc.retro.v1` artifact, and appends a queue item for the
   * recommendations.
   *
   * @remarks
   * Does not catch inference or Chronicle-commit failures — `post` throws
   * and the caller (the run handler, post-merge) owns the loud-but-
   * nonblocking contract: catch here, log/escalate, and let the run's
   * completion proceed regardless. Never call this expecting a settled
   * `Promise` on inference failure.
   */
  post(input: RetroInput): Promise<RetroOutcome>;
}

/** The engine-internal `BUG-*` run convention: `SPEC-BUG-<slug>-P<n>`. */
export const isBugSpec = (specId: string): boolean => /^SPEC-BUG-/.test(specId);

const RETRO_SCHEMA: JsonSchema = {
  type: 'object',
  required: ['recommendations'],
  properties: {
    recommendations: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        required: ['stage', 'check', 'rationale'],
        properties: {
          stage: { type: 'string' },
          check: { type: 'string' },
          rationale: { type: 'string' }
        }
      }
    }
  }
};

@injectable()
export class RetroService implements IRetroService {
  constructor(
    @inject(WORKFLOW_TOKENS.InferenceRepository)
    private readonly _inference: IInferenceRepository,
    @inject(WORKFLOW_TOKENS.QueueRepository)
    private readonly _queueRepo: IQueueRepository,
    @inject(WORKFLOW_TOKENS.ChronicleArtifactRepository)
    private readonly _artifactRepo: IChronicleArtifactRepository
  ) {}

  async post(input: RetroInput): Promise<RetroOutcome> {
    const prompt = buildRetroPrompt(
      input.specId,
      input.context,
      input.verdicts,
      input.exceptions
    );
    const assessment = await this._inference.generateJson<RetroAssessment>(
      prompt,
      RETRO_SCHEMA
    );

    const retro: SdlcRetro = {
      schema: 'sdlc.retro.v1',
      runId: input.runId,
      specId: input.specId,
      recommendations: assessment.recommendations,
      postedAt: new Date().toISOString()
    };

    const artifactPath = this._artifactRepo.writeArtifact(input.chronicleRepo, input.runId, 'retro', {
      schema: 'sdlc.retro.v1',
      runId: input.runId,
      specId: input.specId,
      recordedAt: retro.postedAt,
      payload: retro
    });

    const stages = Array.from(new Set(retro.recommendations.map(rec => rec.stage))).join(', ');
    const title = `Retro: SDLC ${input.runId} ${input.specId} — ${retro.recommendations.length} recommendation(s) for ${stages} (${artifactPath})`;
    const queueAppended = this._queueRepo.appendItem(input.chronicleRepo, title, ['retro']);

    this._artifactRepo.commit(input.chronicleRepo, 'retro', `${input.runId} bug-run retro`);

    return { retro, artifactPath, queueAppended };
  }
}
