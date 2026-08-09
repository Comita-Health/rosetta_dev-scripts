import { inject, injectable } from 'inversify';
import type { IRunStateRepository } from '../repositories/run-state.repository';
import { WORKFLOW_TOKENS } from '../tokens';
import {
  CloseoutAggregate,
  CloseoutCriterion,
  CloseoutTaskGate,
  CriterionVerdict,
  RunState,
  SpecDocument,
  WorkflowError
} from '../types';
import { parseCriterionTier } from '../utils/criterion-tier';
import { evidenceLink } from './digest.service';

export interface CloseoutAggregateInput {
  runsDir: string;
  runId: string;
  /** The spec whose criteria are being covered — the authoritative list. */
  spec: SpecDocument;
}

/**
 * SPEC-PRD-0023-P1 T-01: the read-only closeout view of a run.
 *
 * Walks the spec's tasks and joins each acceptance criterion to the
 * verification verdict the run recorded for it, plus every (task, gate)
 * verdict with its evidence links resolved. Records nothing and judges
 * nothing: this is the aggregation layer the closeout generator (T-02/T-03)
 * derives checkbox and `status:` state from, and it exists precisely so that
 * derivation has a single, testable source.
 *
 * @remarks
 * Criteria the run never judged come back as `no-verdict` rather than being
 * dropped — the generator writes a checkbox for every criterion, so a gap has
 * to be visible as a gap. Callers must treat the result as evidence, not as
 * permission: nothing here decides whether a phase may complete. Phase
 * coverage accepts `pass` or `stood`+`mergedSha` (#169) — never merge alone.
 */
export interface ICloseoutAggregateService {
  aggregate(input: CloseoutAggregateInput): CloseoutAggregate;
}

/** Latest wins: a re-judged criterion appends rather than replacing. */
const latest = (
  verdicts: readonly CriterionVerdict[]
): CriterionVerdict | undefined =>
  verdicts.length === 0
    ? undefined
    : verdicts.reduce((best, verdict) =>
        verdict.recordedAt > best.recordedAt ? verdict : best
      );

@injectable()
export class CloseoutAggregateService implements ICloseoutAggregateService {
  constructor(
    @inject(WORKFLOW_TOKENS.RunStateRepository)
    private readonly _runStateRepo: IRunStateRepository
  ) {}

  aggregate(input: CloseoutAggregateInput): CloseoutAggregate {
    const state = this._runStateRepo.load(input.runsDir, input.runId);
    if (state === null) {
      throw new WorkflowError(
        `run ${input.runId} has no recorded state`,
        'RUN_NOT_FOUND'
      );
    }

    const criteria = this.criteriaFor(input, state);
    const mergedTaskIds = input.spec.tasks
      .filter(task => {
        const merged = state.taskResults[task.id]?.mergedSha;
        return merged !== undefined && merged.length > 0;
      })
      .map(task => task.id);
    const phasePassedTaskIds = input.spec.tasks
      .filter(task => this.phasePassed(state, task.id))
      .map(task => task.id);

    return {
      runId: input.runId,
      specId: input.spec.id,
      criteria,
      taskGates: this.taskGates(input.runId, state),
      taskIds: input.spec.tasks.map(task => task.id),
      mergedTaskIds,
      phasePassedTaskIds,
      fullyCovered:
        criteria.length > 0 &&
        criteria.every(criterion => criterion.coverage === 'pass') &&
        mergedTaskIds.length === input.spec.tasks.length &&
        phasePassedTaskIds.length === input.spec.tasks.length
    };
  }

  private criteriaFor(
    input: CloseoutAggregateInput,
    state: RunState
  ): CloseoutCriterion[] {
    const records: CloseoutCriterion[] = [];
    for (const task of input.spec.tasks) {
      task.acceptanceCriteria.forEach((criterion, offset) => {
        const raw = criterion.trim();
        const verdict = latest(
          state.criterionVerdicts.filter(
            recorded =>
              recorded.taskId === task.id && recorded.criterion.trim() === raw
          )
        );
        // A criterion with no verdict still needs its tier: the generator
        // reports manual-tier remainder differently from an untested one.
        const tier = verdict?.tier ?? parseCriterionTier(raw).tier;
        records.push({
          criterionId: `${task.id}#${offset + 1}`,
          taskId: task.id,
          gate: 'verification',
          index: offset + 1,
          criterion: raw,
          tier,
          coverage: verdict?.outcome ?? 'no-verdict',
          ...(verdict?.evidenceId !== undefined
            ? { evidenceLink: evidenceLink(input.runId, verdict.evidenceId) }
            : {})
        });
      });
    }
    return records;
  }

  /** One record per (task, gate); the latest verdict for that pair wins. */
  private taskGates(runId: string, state: RunState): CloseoutTaskGate[] {
    const byPair = new Map<string, CloseoutTaskGate>();
    for (const verdict of state.verdicts) {
      if (verdict.taskId === undefined) continue;
      const key = `${verdict.taskId}:${verdict.gate}`;
      const existing = byPair.get(key);
      if (existing !== undefined && existing.recordedAt > verdict.recordedAt) {
        continue;
      }
      byPair.set(key, {
        taskId: verdict.taskId,
        gate: verdict.gate,
        outcome: verdict.outcome,
        evidenceLinks: (verdict.evidenceIds ?? []).map(id =>
          evidenceLink(runId, id)
        ),
        recordedAt: verdict.recordedAt
      });
    }
    return [...byPair.values()].sort((a, b) =>
      a.taskId === b.taskId
        ? a.gate.localeCompare(b.gate)
        : a.taskId.localeCompare(b.taskId)
    );
  }

  /**
   * Phase coverage for closeout: a green phase, or a human-approved merge
   * that left a prior breach standing (`phase: stood` from `record-merge`).
   * MergedSha alone is not enough — escalate-then-Approve must leave an
   * explicit stood (or pass) record, never a silent gap.
   */
  private phasePassed(state: RunState, taskId: string): boolean {
    const phases = state.verdicts.filter(
      verdict => verdict.gate === 'phase' && verdict.taskId === taskId
    );
    const newest = phases.reduce<(typeof phases)[number] | undefined>(
      (best, verdict) =>
        best === undefined || verdict.recordedAt > best.recordedAt
          ? verdict
          : best,
      undefined
    );
    if (newest === undefined) {
      return false;
    }
    if (newest.outcome === 'pass') {
      return true;
    }
    if (newest.outcome !== 'stood') {
      return false;
    }
    const merged = state.taskResults[taskId]?.mergedSha;
    return merged !== undefined && merged.length > 0;
  }
}
