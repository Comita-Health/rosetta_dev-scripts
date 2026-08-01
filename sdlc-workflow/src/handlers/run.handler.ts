import { inject, injectable } from 'inversify';
import chalk from 'chalk';
import type { IRunStateRepository } from '../repositories/run-state.repository';
import type { IAggregatorService } from '../services/aggregator.service';
import type { IEnvelopeGateService } from '../services/envelope-gate.service';
import type {
  ExecutorInput,
  ExecutorOutcome,
  IExecutorService
} from '../services/executor.service';
import type { IReviewerGateService } from '../services/reviewer-gate.service';
import { WORKFLOW_TOKENS } from '../tokens';
import { GateVerdict } from '../types';

export interface RunTaskInput extends ExecutorInput {}

export interface RunTaskResult {
  outcome: ExecutorOutcome['kind'];
  taskId?: string;
  branch?: string;
}

/**
 * SPEC-PRD-0011-P2 single-task loop: execute one ready task in an isolated
 * worktree (T-01), run the envelope (T-02) and reviewer (T-05) gates in
 * shadow mode, aggregate the phase verdict and exception ledger (T-06),
 * persist everything, and halt — human approval remains the only advance
 * mechanism this phase. CI and verification gates join in T-03/T-04.
 */
export interface IRunHandler {
  runTask(input: RunTaskInput): Promise<RunTaskResult>;
}

@injectable()
export class RunHandler implements IRunHandler {
  constructor(
    @inject(WORKFLOW_TOKENS.ExecutorService)
    private readonly _executor: IExecutorService,
    @inject(WORKFLOW_TOKENS.EnvelopeGateService)
    private readonly _envelopeGate: IEnvelopeGateService,
    @inject(WORKFLOW_TOKENS.ReviewerGateService)
    private readonly _reviewerGate: IReviewerGateService,
    @inject(WORKFLOW_TOKENS.AggregatorService)
    private readonly _aggregator: IAggregatorService,
    @inject(WORKFLOW_TOKENS.RunStateRepository)
    private readonly _runStateRepo: IRunStateRepository
  ) {}

  async runTask(input: RunTaskInput): Promise<RunTaskResult> {
    console.log(chalk.bold(`\nRun ${input.runId} — ${input.specPath}\n`));

    const outcome = await this._executor.executeNext(input);

    if (outcome.kind === 'blocked') {
      console.log(
        chalk.red(
          '  ✗ Refused: spec is not Approved (blocked verdict recorded: unapproved-spec).'
        )
      );
      console.log(
        '  Approve the spec (status: Draft → Approved, ADR-0008) and rerun.'
      );
      return { outcome: outcome.kind };
    }

    if (outcome.kind === 'no-ready-task') {
      console.log(
        chalk.yellow('  No ready task (all done or blocked on dependencies).')
      );
      return { outcome: outcome.kind };
    }

    const task = outcome.task;
    const state = outcome.state;
    if (task === undefined || state === null || outcome.branch === undefined) {
      // Executor contract guarantees these for completed/failed outcomes.
      throw new Error('executor returned an incomplete outcome');
    }

    const icon =
      outcome.kind === 'completed' ? chalk.green('✓') : chalk.red('✗');
    console.log(`  ${icon} ${task.id} ${outcome.kind} on ${outcome.branch}`);
    if (outcome.detail !== undefined) {
      console.log(chalk.gray(`    ${outcome.detail.slice(0, 300)}`));
    }

    const envelopeVerdict = await this._envelopeGate.evaluate({
      repoPath: input.repoPath,
      baseRef: state.baseSha,
      headRef: outcome.branch,
      envelope: outcome.spec.envelope
    });
    this._runStateRepo.appendVerdict(input.runsDir, state, envelopeVerdict);
    this.printVerdict(envelopeVerdict);

    const reviewerVerdict = await this._reviewerGate.review({
      repoPath: input.repoPath,
      baseRef: state.baseSha,
      headRef: outcome.branch,
      task,
      envelope: outcome.spec.envelope
    });
    this._runStateRepo.appendVerdict(input.runsDir, state, reviewerVerdict);
    this.printVerdict(reviewerVerdict);

    // CI and the verification runner are not wired yet (T-03/T-04); the
    // aggregator sees them as blocked so the phase verdict stays honest.
    const pendingGate = (gate: string): GateVerdict => ({
      gate,
      outcome: 'blocked',
      wouldEscalate: false,
      reasons: ['not wired this slice (T-03/T-04)'],
      recordedAt: new Date().toISOString()
    });

    const { verdict: phaseVerdict, exceptions } = this._aggregator.aggregate({
      gates: {
        ci: pendingGate('ci'),
        verification: pendingGate('verification'),
        reviewer: reviewerVerdict,
        envelope: envelopeVerdict
      },
      state,
      taskId: task.id,
      budgetK: outcome.spec.envelope.budgetK
    });
    this._runStateRepo.appendVerdict(input.runsDir, state, phaseVerdict);
    this._runStateRepo.recordExceptions(input.runsDir, state, exceptions);
    this.printVerdict(phaseVerdict);
    for (const entry of exceptions) {
      console.log(
        chalk.yellow(`  [ledger] ${entry.trigger}: ${entry.context.join('; ')}`)
      );
    }

    console.log(chalk.bold('\n[HUMAN GATE] Shadow mode — nothing advances.'));
    console.log(`  Review branch ${outcome.branch} and the recorded verdicts;`);
    console.log(
      '  merging (or not) is your call. Gate enforcement is Phase 3.'
    );

    return { outcome: outcome.kind, taskId: task.id, branch: outcome.branch };
  }

  private printVerdict(verdict: GateVerdict): void {
    const color = verdict.outcome === 'pass' ? chalk.green : chalk.red;
    console.log(
      color(
        `  [shadow] ${verdict.gate} gate: ${verdict.outcome}` +
          (verdict.wouldEscalate ? ' (would escalate)' : '')
      )
    );
    for (const reason of verdict.reasons) {
      console.log(chalk.gray(`    - ${reason}`));
    }
  }
}
