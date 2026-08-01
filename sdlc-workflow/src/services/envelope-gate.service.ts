import { inject, injectable } from 'inversify';
import type { IGitRepository } from '../repositories/git.repository';
import type { ISurfaceMapRepository } from '../repositories/surface-map.repository';
import { WORKFLOW_TOKENS } from '../tokens';
import { Envelope, GateVerdict } from '../types';
import { matchesAnyGlob } from '../utils/glob-match';

export interface EnvelopeGateInput {
  repoPath: string;
  baseRef: string;
  headRef: string;
  envelope: Envelope;
}

/**
 * SPEC-PRD-0011-P2 T-02: evaluate a task branch diff against the spec's
 * blast-radius envelope. Shadow semantics — the verdict is computed and
 * returned with `wouldEscalate` on breach; it never blocks. Persistence
 * and flow control belong to the handler.
 */
export interface IEnvelopeGateService {
  evaluate(input: EnvelopeGateInput): Promise<GateVerdict>;
}

@injectable()
export class EnvelopeGateService implements IEnvelopeGateService {
  constructor(
    @inject(WORKFLOW_TOKENS.GitRepository)
    private readonly _gitRepo: IGitRepository,
    @inject(WORKFLOW_TOKENS.SurfaceMapRepository)
    private readonly _surfaceRepo: ISurfaceMapRepository
  ) {}

  async evaluate(input: EnvelopeGateInput): Promise<GateVerdict> {
    const diff = this._gitRepo.diffStat(
      input.repoPath,
      input.baseRef,
      input.headRef
    );
    const surfaceMap = this._surfaceRepo.load(input.repoPath);
    const reasons: string[] = [];

    const outsideAllowed = diff.files
      .filter(file => !matchesAnyGlob(input.envelope.allowedPaths, file.path))
      .map(file => file.path);
    if (outsideAllowed.length > 0) {
      reasons.push(`outside allowedPaths: ${outsideAllowed.join(', ')}`);
    }

    for (const label of input.envelope.forbiddenSurfaces) {
      const globs = surfaceMap[label];
      if (globs === undefined) {
        reasons.push(`unresolvable surface label: ${label}`);
        continue;
      }
      const touched = diff.files
        .filter(file => matchesAnyGlob(globs, file.path))
        .map(file => file.path);
      if (touched.length > 0) {
        reasons.push(
          `forbidden surface "${label}" touched: ${touched.join(', ')}`
        );
      }
    }

    if (diff.totalLines > input.envelope.maxDiffLines) {
      reasons.push(
        `diff is ${diff.totalLines} lines, exceeding maxDiffLines ${input.envelope.maxDiffLines}`
      );
    }

    const breach = reasons.length > 0;
    return {
      gate: 'envelope',
      outcome: breach ? 'breach' : 'pass',
      wouldEscalate: breach,
      reasons,
      recordedAt: new Date().toISOString()
    };
  }
}
