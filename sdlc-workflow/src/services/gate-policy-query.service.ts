import { inject, injectable } from 'inversify';
import type { IChronicleArtifactRepository } from '../repositories/chronicle-artifact.repository';
import { WORKFLOW_TOKENS } from '../tokens';
import { VerdictArtifactPayload } from '../types';

/**
 * SPEC-PRD-0011-P2 T-08: the gate-policy consumption interface. Reads gate
 * verdicts back from committed Chronicle artifacts so future policy (e.g.
 * auto-advance thresholds) can learn from track record. Read-only.
 */
export interface IGatePolicyQueryService {
  verdicts(
    chronicleRepo: string,
    runId: string,
    gate?: string
  ): VerdictArtifactPayload[];
}

@injectable()
export class GatePolicyQueryService implements IGatePolicyQueryService {
  constructor(
    @inject(WORKFLOW_TOKENS.ChronicleArtifactRepository)
    private readonly _artifactRepo: IChronicleArtifactRepository
  ) {}

  verdicts(
    chronicleRepo: string,
    runId: string,
    gate?: string
  ): VerdictArtifactPayload[] {
    return this._artifactRepo
      .readArtifacts(chronicleRepo, runId)
      .filter(artifact => artifact.schema === 'sdlc.verdict.v1')
      .map(artifact => artifact.payload as VerdictArtifactPayload)
      .filter(payload => gate === undefined || payload.gate === gate);
  }
}
