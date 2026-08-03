import { inject, injectable } from 'inversify';
import type { IAgentRunnerRepository } from '../repositories/agent-runner.repository';
import type { IContractRepository } from '../repositories/contract.repository';
import type { IEvidenceRepository } from '../repositories/evidence.repository';
import type { IShellCommandRepository } from '../repositories/shell-command.repository';
import { WORKFLOW_TOKENS } from '../tokens';
import {
  CriterionOutcome,
  CriterionVerdict,
  GateVerdict,
  SpecTask
} from '../types';
import { parseAllCriteria, TieredCriterion } from '../utils/criterion-tier';
import { extractJson } from '../utils/json-schema';
import { buildVerifierPrompt } from '../utils/verifier-prompt';

export interface VerificationInput {
  worktreePath: string;
  runsDir: string;
  runId: string;
  task: SpecTask;
  /** Sandbox health output; absent when the sandbox gate did not pass. */
  healthReport?: string;
  /**
   * Test-tier verdicts already computed by {@link verifyTestTierOnly}, run
   * by the caller in parallel with the sandbox deploy. When present, the
   * test-tier scripted check is not re-run.
   */
  precomputedTestTier?: CriterionVerdict[];
}

/** Fields {@link verifyTestTierOnly} needs — no sandbox health report. */
export type TestTierInput = Pick<
  VerificationInput,
  'worktreePath' | 'runsDir' | 'runId' | 'task'
>;

export interface VerificationOutcome {
  verdict: GateVerdict;
  criteria: CriterionVerdict[];
}

const TEST_TIMEOUT_MS = 30 * 60_000;

/**
 * SPEC-PRD-0011-P2 T-04: verify a task's acceptance criteria by tier.
 * All criteria are parsed up front — an invalid prefix aborts before any
 * execution. test-tier criteria run the repo's scripted check
 * (`.sdlc/verification.json` → testCommand) with captured output as
 * evidence; agent-tier criteria are handed to an independent verifier
 * agent that drives the running sandbox, its transcript attached as
 * evidence; manual-tier criteria force a human-required verdict. The
 * aggregate is green only when every criterion passes.
 *
 * The test tier has no dependency on the sandbox deploy — only agent-tier
 * criteria consume `healthReport`. {@link verifyTestTierOnly} lets the
 * orchestrator run it concurrently with the sandbox gate instead of paying
 * for both sequentially.
 */
export interface IVerificationService {
  verify(input: VerificationInput): Promise<VerificationOutcome>;
  /**
   * Runs just the test-tier scripted check, independent of the sandbox.
   * Returns `undefined` on a criteria-parse failure so the caller's
   * subsequent `verify()` call — not this shortcut — surfaces the error.
   */
  verifyTestTierOnly(
    input: TestTierInput
  ): Promise<CriterionVerdict[] | undefined>;
}

@injectable()
export class VerificationService implements IVerificationService {
  constructor(
    @inject(WORKFLOW_TOKENS.ContractRepository)
    private readonly _contractRepo: IContractRepository,
    @inject(WORKFLOW_TOKENS.ShellCommandRepository)
    private readonly _shellRepo: IShellCommandRepository,
    @inject(WORKFLOW_TOKENS.AgentRunnerRepository)
    private readonly _agentRepo: IAgentRunnerRepository,
    @inject(WORKFLOW_TOKENS.EvidenceRepository)
    private readonly _evidenceRepo: IEvidenceRepository
  ) {}

  async verify(input: VerificationInput): Promise<VerificationOutcome> {
    // Validation completes for every criterion before anything executes.
    const tiered = parseAllCriteria(input.task.acceptanceCriteria);
    const verdicts: CriterionVerdict[] = [];

    const testTier = tiered.filter(criterion => criterion.tier === 'test');
    if (testTier.length > 0) {
      verdicts.push(
        ...(input.precomputedTestTier ??
          (await this.runTestTier(input, testTier)))
      );
    }

    for (const criterion of tiered.filter(item => item.tier === 'agent')) {
      verdicts.push(await this.runAgentTier(input, criterion));
    }

    for (const criterion of tiered.filter(item => item.tier === 'manual')) {
      verdicts.push(this.criterionVerdict(input, criterion, 'human-required'));
    }

    return { verdict: this.aggregate(verdicts), criteria: verdicts };
  }

  async verifyTestTierOnly(
    input: TestTierInput
  ): Promise<CriterionVerdict[] | undefined> {
    let tiered: TieredCriterion[];
    try {
      tiered = parseAllCriteria(input.task.acceptanceCriteria);
    } catch {
      // Malformed criteria: let the real verify() call raise this the same
      // way it always has, instead of duplicating that error path here.
      return undefined;
    }
    const testTier = tiered.filter(criterion => criterion.tier === 'test');
    if (testTier.length === 0) return [];
    return this.runTestTier(input as VerificationInput, testTier);
  }

  private async runTestTier(
    input: VerificationInput,
    criteria: TieredCriterion[]
  ): Promise<CriterionVerdict[]> {
    const contract = this._contractRepo.loadVerification(input.worktreePath);
    if (contract === null) {
      // Without a scripted-check contract the tier cannot execute; a human
      // must verify, so the criteria degrade to human-required.
      return criteria.map(criterion =>
        this.criterionVerdict(input, criterion, 'human-required')
      );
    }

    // One scripted-check run covers the tier; each criterion records its
    // own verdict referencing the shared captured-output artifact.
    const result = await this._shellRepo.run(
      input.worktreePath,
      contract.testCommand,
      { SDLC_TASK_ID: input.task.id },
      TEST_TIMEOUT_MS
    );
    const evidenceId = `${input.task.id}-test-output`;
    this._evidenceRepo.save(
      input.runsDir,
      input.runId,
      evidenceId,
      result.output
    );

    return criteria.map(criterion =>
      this.criterionVerdict(
        input,
        criterion,
        result.ok ? 'pass' : 'fail',
        evidenceId
      )
    );
  }

  private async runAgentTier(
    input: VerificationInput,
    criterion: TieredCriterion
  ): Promise<CriterionVerdict> {
    const index = input.task.acceptanceCriteria.indexOf(criterion.raw) + 1;
    const evidenceId = `${input.task.id}-agent-criterion-${index}`;

    const prompt = buildVerifierPrompt(
      input.task,
      criterion.body,
      input.healthReport ?? 'No sandbox health report available.'
    );
    let outcome: CriterionOutcome = 'fail';
    let transcript = '';
    try {
      const run = await this._agentRepo.run(input.worktreePath, prompt);
      transcript = run.output;
      if (run.ok) {
        const parsed = extractJson(run.output) as { pass?: unknown };
        outcome = parsed.pass === true ? 'pass' : 'fail';
      }
    } catch (err) {
      transcript = `${transcript}\n[verifier error] ${
        err instanceof Error ? err.message : String(err)
      }`.trim();
    }

    this._evidenceRepo.save(input.runsDir, input.runId, evidenceId, transcript);
    return this.criterionVerdict(input, criterion, outcome, evidenceId);
  }

  private criterionVerdict(
    input: VerificationInput,
    criterion: TieredCriterion,
    outcome: CriterionOutcome,
    evidenceId?: string
  ): CriterionVerdict {
    return {
      taskId: input.task.id,
      criterion: criterion.raw,
      tier: criterion.tier,
      outcome,
      evidenceId,
      recordedAt: new Date().toISOString()
    };
  }

  private aggregate(verdicts: CriterionVerdict[]): GateVerdict {
    const failing = verdicts.filter(verdict => verdict.outcome === 'fail');
    const manual = verdicts.filter(
      verdict => verdict.outcome === 'human-required'
    );

    let outcome: GateVerdict['outcome'] = 'pass';
    if (failing.length > 0) outcome = 'breach';
    else if (manual.length > 0) outcome = 'human-required';

    const evidenceIds = [
      ...new Set(
        verdicts
          .map(verdict => verdict.evidenceId)
          .filter((id): id is string => id !== undefined)
      )
    ];

    return {
      gate: 'verification',
      outcome,
      // human-required escalates too: it blocks the merge exactly like a
      // failure, so staying silent would strand the task with no ledger
      // entry and nothing for a human to act on.
      wouldEscalate: failing.length > 0 || manual.length > 0,
      reasons: [
        ...failing.map(verdict => `failed: ${verdict.criterion}`),
        ...manual.map(verdict => `human required: ${verdict.criterion}`)
      ],
      evidenceIds,
      recordedAt: new Date().toISOString()
    };
  }
}
