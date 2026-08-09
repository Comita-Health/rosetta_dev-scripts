import { inject, injectable } from 'inversify';
import type { IChronicleArtifactRepository } from '../repositories/chronicle-artifact.repository';
import type { IRunStateRepository } from '../repositories/run-state.repository';
import { WORKFLOW_TOKENS } from '../tokens';
import {
  ChronicleArtifact,
  GateVerdict,
  OutcomeArtifactPayload,
  RunState,
  SpecDocument,
  VerdictArtifactPayload,
  VerdictOutcome,
  WorkflowError
} from '../types';
import { inputsDigest } from '../utils/digest';

export interface ChronicleRecordInput {
  chronicleRepo: string;
  spec: SpecDocument;
  state: RunState;
}

export interface ChronicleRecordOutcome {
  /** Repo-relative paths of every artifact written. */
  artifactPaths: string[];
}

export interface RecordMergeInput {
  chronicleRepo: string;
  runsDir: string;
  runId: string;
  mergedSha: string;
  /**
   * P3 T-01: when set, also records the merge on this task's result,
   * which is what makes its dependents eligible in the pool.
   */
  taskId?: string;
  /** P3 T-04: who authorized the merge. Defaults to 'human'. */
  approvedBy?: 'human' | 'machine-gates' | 'out-of-band';
}

/**
 * SPEC-PRD-0011-P2 T-08: commit run outputs to the Chronicle as versioned
 * JSON artifacts — the consumed spec, per-task results, every gate verdict
 * (gate identity + inputs digest + outcome + evidence refs), and the
 * exception ledger. A human-approved merge records the merged SHA via
 * {@link recordMerge}. Commits follow ADR-0007 (`chronicle(sdlc): ...`
 * with provenance trailers) and a clean tree is a no-op, so resume never
 * duplicates ledger writes.
 */
export interface RecordRevertInput {
  chronicleRepo: string;
  runId: string;
  specId: string;
  /** Merge commits of the phase that the revert covers. */
  revertedShas: string[];
  /** Head of the revert branch. */
  revertSha: string;
  /** PR carrying the revert to the default branch. */
  prUrl: string;
  /**
   * BUG-reviewer-house-bar-P1 T-02: the reverted tasks' gate verdicts,
   * annotated `outcome: vetoed` (one outcome record per task/gate) so
   * gate precision is computable from the ledger.
   */
  revertedVerdicts?: GateVerdict[];
}

export interface IChronicleCommitService {
  record(input: ChronicleRecordInput): Promise<ChronicleRecordOutcome>;
  recordMerge(input: RecordMergeInput): Promise<string>;
  /** P3 T-05: record a veto-triggered revert (sdlc.revert.v1). */
  recordRevert(input: RecordRevertInput): Promise<string>;
}

@injectable()
export class ChronicleCommitService implements IChronicleCommitService {
  constructor(
    @inject(WORKFLOW_TOKENS.ChronicleArtifactRepository)
    private readonly _artifactRepo: IChronicleArtifactRepository,
    @inject(WORKFLOW_TOKENS.RunStateRepository)
    private readonly _runStateRepo: IRunStateRepository
  ) {}

  async record(input: ChronicleRecordInput): Promise<ChronicleRecordOutcome> {
    const { chronicleRepo, spec, state } = input;
    const now = new Date().toISOString();
    const paths: string[] = [];
    const write = (name: string, artifact: ChronicleArtifact): void => {
      paths.push(
        this._artifactRepo.writeArtifact(
          chronicleRepo,
          state.runId,
          name,
          artifact
        )
      );
    };

    write('spec', {
      schema: 'sdlc.spec.v1',
      runId: state.runId,
      specId: spec.id,
      recordedAt: now,
      payload: {
        status: spec.status,
        contentDigest: inputsDigest(spec),
        envelope: spec.envelope,
        tasks: spec.tasks
      }
    });

    for (const result of Object.values(state.taskResults)) {
      write(`task-${result.taskId}`, {
        schema: 'sdlc.task-result.v1',
        runId: state.runId,
        specId: spec.id,
        recordedAt: now,
        payload: result
      });
    }

    state.verdicts.forEach((verdict, index) => {
      const payload: VerdictArtifactPayload = {
        gate: verdict.gate,
        inputsDigest:
          verdict.inputsDigest ??
          inputsDigest({ gate: verdict.gate, reasons: verdict.reasons }),
        outcome: verdict.outcome,
        wouldEscalate: verdict.wouldEscalate,
        reasons: verdict.reasons,
        evidenceRefs: verdict.evidenceIds ?? [],
        taskId: verdict.taskId ?? 'run'
      };
      write(`verdict-${String(index).padStart(3, '0')}-${verdict.gate}`, {
        schema: 'sdlc.verdict.v1',
        runId: state.runId,
        specId: spec.id,
        recordedAt: now,
        payload
      });
    });

    write('exceptions', {
      schema: 'sdlc.exceptions.v1',
      runId: state.runId,
      specId: spec.id,
      recordedAt: now,
      payload: state.exceptions
    });

    this._artifactRepo.commit(
      chronicleRepo,
      'sdlc',
      `${state.runId} run artifacts`
    );
    return { artifactPaths: paths };
  }

  async recordMerge(input: RecordMergeInput): Promise<string> {
    const state = this._runStateRepo.load(input.runsDir, input.runId);
    if (state === null) {
      throw new WorkflowError(
        `run ${input.runId} has no recorded state`,
        'RUN_NOT_FOUND'
      );
    }
    this._runStateRepo.recordMergedSha(input.runsDir, state, input.mergedSha);
    if (input.taskId !== undefined) {
      this._runStateRepo.recordTaskMerged(
        input.runsDir,
        state,
        input.taskId,
        input.mergedSha
      );
      // T-02: the merge stood — annotate this task's gate verdicts so
      // per-gate precision is computable from the ledger.
      this.writeOutcomes(
        input.chronicleRepo,
        input.runId,
        state.specId,
        state.verdicts.filter(verdict => verdict.taskId === input.taskId),
        'stood'
      );
    }

    const path = this._artifactRepo.writeArtifact(
      input.chronicleRepo,
      input.runId,
      'merge',
      {
        schema: 'sdlc.merge.v1',
        runId: input.runId,
        specId: state.specId,
        recordedAt: new Date().toISOString(),
        payload: {
          mergedSha: input.mergedSha,
          approvedBy: input.approvedBy ?? 'human',
          ...(input.taskId !== undefined ? { taskId: input.taskId } : {})
        }
      }
    );
    this._artifactRepo.commit(
      input.chronicleRepo,
      'sdlc',
      `${input.runId} merged at ${input.mergedSha.slice(0, 12)}`
    );
    return path;
  }

  async recordRevert(input: RecordRevertInput): Promise<string> {
    // T-02: the merge was vetoed — annotate the reverted tasks' gate
    // verdicts so per-gate precision is computable from the ledger.
    if (
      input.revertedVerdicts !== undefined &&
      input.revertedVerdicts.length > 0
    ) {
      this.writeOutcomes(
        input.chronicleRepo,
        input.runId,
        input.specId,
        input.revertedVerdicts,
        'vetoed'
      );
    }
    const path = this._artifactRepo.writeArtifact(
      input.chronicleRepo,
      input.runId,
      'revert',
      {
        schema: 'sdlc.revert.v1',
        runId: input.runId,
        specId: input.specId,
        recordedAt: new Date().toISOString(),
        payload: {
          revertedShas: input.revertedShas,
          revertSha: input.revertSha,
          prUrl: input.prUrl,
          trigger: 'queue-veto'
        }
      }
    );
    this._artifactRepo.commit(
      input.chronicleRepo,
      'sdlc',
      `${input.runId} veto revert at ${input.revertSha.slice(0, 12)}`
    );
    return path;
  }

  /**
   * T-02: write one `sdlc.outcome.v1` artifact per (taskId, gate) pair
   * present in `verdicts`, keyed by `outcome-<taskId>-<gate>` so
   * re-recording the same outcome (e.g. a resumed run replaying a cached
   * step) overwrites the same file instead of appending a duplicate. When
   * a gate recorded more than one verdict for the same task (retries), the
   * most recent one wins.
   *
   * The dedup key must include `taskId`, not just `gate`: `verdicts` can
   * span every task in a reverted phase (see {@link recordRevert}), and
   * multiple tasks routinely share generic gate names like `envelope` or
   * `verification`. Keying on `gate` alone would collapse those distinct
   * tasks' verdicts into a single outcome record and silently drop the
   * rest — defeating the point of a per-task, per-gate ledger.
   */
  private writeOutcomes(
    chronicleRepo: string,
    runId: string,
    specId: string,
    verdicts: GateVerdict[],
    outcome: VerdictOutcome
  ): void {
    const now = new Date().toISOString();
    const latestByTaskGate = new Map<string, GateVerdict>();
    for (const verdict of verdicts) {
      const taskId = verdict.taskId ?? 'run';
      latestByTaskGate.set(`${taskId}:${verdict.gate}`, verdict);
    }
    for (const verdict of latestByTaskGate.values()) {
      const taskId = verdict.taskId ?? 'run';
      const payload: OutcomeArtifactPayload = {
        taskId,
        gate: verdict.gate,
        verdictInputsDigest:
          verdict.inputsDigest ??
          inputsDigest({
            gate: verdict.gate,
            taskId,
            reasons: verdict.reasons
          }),
        outcome
      };
      this._artifactRepo.writeArtifact(
        chronicleRepo,
        runId,
        `outcome-${taskId}-${verdict.gate}`,
        {
          schema: 'sdlc.outcome.v1',
          runId,
          specId,
          recordedAt: now,
          payload
        }
      );
    }
  }
}
