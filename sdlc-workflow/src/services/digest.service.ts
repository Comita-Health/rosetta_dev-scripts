import { inject, injectable } from 'inversify';
import type { IChronicleArtifactRepository } from '../repositories/chronicle-artifact.repository';
import type { IQueueRepository } from '../repositories/queue.repository';
import { WORKFLOW_TOKENS } from '../tokens';
import { ExceptionEntry, GateVerdict } from '../types';

export interface DigestInput {
  chronicleRepo: string;
  runId: string;
  specId: string;
  taskId: string;
  /** The aggregate phase verdict (T-06 output). */
  phaseVerdict: GateVerdict;
  /** Every gate verdict recorded for the task. */
  verdicts: GateVerdict[];
  /** Exception-ledger entries derived for the task. */
  exceptions: ExceptionEntry[];
}

/** The digest document posted at a phase boundary (T-07). */
export interface SdlcDigest {
  schema: 'sdlc.digest.v1';
  runId: string;
  specId: string;
  taskId: string;
  phaseOutcome: GateVerdict['outcome'];
  gates: Array<{
    gate: string;
    outcome: GateVerdict['outcome'];
    wouldEscalate: boolean;
    reasons: string[];
    evidenceLinks: string[];
  }>;
  exceptions: ExceptionEntry[];
  postedAt: string;
}

export interface DigestOutcome {
  digest: SdlcDigest;
  /** Repo-relative path of the committed digest artifact. */
  artifactPath: string;
  /** False when the queue already held this digest (resume idempotency). */
  queueAppended: boolean;
}

/**
 * SPEC-PRD-0011-P2 T-07: post one digest per phase boundary to the
 * PRD-0007 personal queue — informational only. The digest document
 * (task ID, aggregate verdict, per-gate verdicts with evidence links,
 * exception entries) is committed to the Chronicle repo and a queue item
 * pointing at it is appended to the Inbox via the existing queue file
 * contract. There is deliberately no veto-handling or revert path here:
 * whatever a human does with the queue item, this service only ever
 * appends, and re-posting the same digest is a no-op.
 */
export interface IDigestService {
  post(input: DigestInput): Promise<DigestOutcome>;
}

/** Evidence IDs resolve through the run's evidence store. */
export const evidenceLink = (runId: string, evidenceId: string): string =>
  `runs://${runId}/evidence/${evidenceId}`;

@injectable()
export class DigestService implements IDigestService {
  constructor(
    @inject(WORKFLOW_TOKENS.QueueRepository)
    private readonly _queueRepo: IQueueRepository,
    @inject(WORKFLOW_TOKENS.ChronicleArtifactRepository)
    private readonly _artifactRepo: IChronicleArtifactRepository
  ) {}

  async post(input: DigestInput): Promise<DigestOutcome> {
    const digest: SdlcDigest = {
      schema: 'sdlc.digest.v1',
      runId: input.runId,
      specId: input.specId,
      taskId: input.taskId,
      phaseOutcome: input.phaseVerdict.outcome,
      gates: input.verdicts.map(verdict => ({
        gate: verdict.gate,
        outcome: verdict.outcome,
        wouldEscalate: verdict.wouldEscalate,
        reasons: verdict.reasons,
        evidenceLinks: (verdict.evidenceIds ?? []).map(id =>
          evidenceLink(input.runId, id)
        )
      })),
      exceptions: input.exceptions,
      postedAt: new Date().toISOString()
    };

    const artifactPath = this._artifactRepo.writeArtifact(
      input.chronicleRepo,
      input.runId,
      `digest-${input.taskId}`,
      {
        schema: 'sdlc.digest.v1',
        runId: input.runId,
        specId: input.specId,
        recordedAt: digest.postedAt,
        payload: digest
      }
    );

    const title = `Review SDLC digest ${input.runId} ${input.taskId} — phase ${digest.phaseOutcome} (${artifactPath})`;
    const queueAppended = this._queueRepo.appendItem(
      input.chronicleRepo,
      title,
      ['follow-up']
    );

    this._artifactRepo.commit(
      input.chronicleRepo,
      'queue',
      `sdlc digest ${input.runId} ${input.taskId}`
    );

    return { digest, artifactPath, queueAppended };
  }
}
