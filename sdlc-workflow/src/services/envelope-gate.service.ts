import { inject, injectable } from 'inversify';
import type { IGitRepository } from '../repositories/git.repository';
import {
  SURFACES_CONTRACT_PATH,
  type ISurfaceMapRepository
} from '../repositories/surface-map.repository';
import { WORKFLOW_TOKENS } from '../tokens';
import { Envelope, GateVerdict } from '../types';
import { matchesAnyGlob } from '../utils/glob-match';
import { isSpecTreePath } from '../utils/spec-path';

/** Common JS/TS test-file conventions, kept generic (no repo-specific runner assumed). */
const TEST_PATH_GLOBS = [
  '**/*.test.*',
  '**/*.spec.*',
  '**/__tests__/**',
  '**/__mocks__/**'
] as const;

/**
 * True when a repo-relative path is a test file by common JS/TS convention.
 * `maxDiffLines` exempts these (BUG-retro-and-queued-plans-P1 retro): a
 * thorough, well-tested change is not a bigger blast radius than a thin one,
 * and penalizing test bulk the same as production code perversely
 * discourages coverage. `allowedPaths` / `forbiddenSurfaces` still apply to
 * test files unchanged — only the size budget exempts them.
 */
export const isTestPath = (filePath: string): boolean =>
  matchesAnyGlob([...TEST_PATH_GLOBS], filePath);

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
 *
 * Always breaches on any path under a specs/ tree (repo-root or nested), even
 * if that path is listed in allowedPaths — checkbox / Done closeout is a
 * separate docs PR after the phase, not a product-task diff.
 *
 * Contract resolution (SPEC-BUG-envelope-spec-integrity-P1 T-03): the
 * surface map is read from the git tree under judgment (`headRef` — the
 * task PR tip, or the merged integration tip for phase-level checks),
 * never from the operator's local checkout. A contract missing at that
 * tree is a named breach reason, not a local-file fallback.
 *
 * `maxDiffLines` budgets non-test lines only (BUG-retro-and-queued-plans-P1
 * retro): test files ({@link isTestPath}) still count for `allowedPaths` /
 * `forbiddenSurfaces`, but their line count is excluded from the size
 * budget so thorough test coverage never forces a task to either under-test
 * or breach on size alone.
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
    // T-03 (SPEC-BUG-envelope-spec-integrity-P1): the contract is read from
    // the tree under judgment — the headRef blob — never the operator's
    // working copy, so a locally edited surfaces.json cannot sway a verdict.
    const surfaceMap = this._surfaceRepo.loadAtRef(
      input.repoPath,
      input.headRef
    );
    const reasons: string[] = [];

    const outsideAllowed = diff.files
      .filter(file => !matchesAnyGlob(input.envelope.allowedPaths, file.path))
      .map(file => file.path);
    if (outsideAllowed.length > 0) {
      reasons.push(`outside allowedPaths: ${outsideAllowed.join(', ')}`);
    }

    const midRunSpecEdits = diff.files
      .filter(file => isSpecTreePath(file.path))
      .map(file => file.path);
    if (midRunSpecEdits.length > 0) {
      reasons.push(
        `mid-run specs/** edits are forbidden (closeout is a separate docs PR): ${midRunSpecEdits.join(', ')}`
      );
    }

    if (surfaceMap === null) {
      if (input.envelope.forbiddenSurfaces.length > 0) {
        // Named error, not a local-disk fallback: labels cannot be resolved
        // when the judged tree carries no surface contract.
        reasons.push(
          `surface contract ${SURFACES_CONTRACT_PATH} missing from judged ` +
            `tree ${input.headRef}; cannot resolve forbiddenSurfaces: ` +
            input.envelope.forbiddenSurfaces.join(', ')
        );
      }
    } else {
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
    }

    const nonTestLines = diff.files
      .filter(file => !isTestPath(file.path))
      .reduce((sum, file) => sum + file.lines, 0);
    if (nonTestLines > input.envelope.maxDiffLines) {
      reasons.push(
        `diff is ${nonTestLines} non-test lines (${diff.totalLines} total ` +
          `including tests), exceeding maxDiffLines ${input.envelope.maxDiffLines}`
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
