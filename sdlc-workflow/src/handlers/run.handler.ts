import { inject, injectable } from 'inversify';
import chalk from 'chalk';
import path from 'path';
import type { IGitRepository } from '../repositories/git.repository';
import type { IRunStateRepository } from '../repositories/run-state.repository';
import type { IAggregatorService } from '../services/aggregator.service';
import type { IEnvelopeGateService } from '../services/envelope-gate.service';
import type {
  ExecutorInput,
  ExecutorOutcome,
  IExecutorService
} from '../services/executor.service';
import type { IReviewerGateService } from '../services/reviewer-gate.service';
import type { ISandboxDeployService } from '../services/sandbox-deploy.service';
import type {
  IVerificationService,
  VerificationOutcome
} from '../services/verification.service';
import { WORKFLOW_TOKENS } from '../tokens';
import { GateVerdict, WorkflowError } from '../types';

export interface RunTaskInput extends ExecutorInput {}

export interface RunTaskResult {
  outcome: ExecutorOutcome['kind'];
  taskId?: string;
  branch?: string;
}

/**
 * SPEC-PRD-0011-P2 single-task loop: execute one ready task in an isolated
 * worktree (T-01), deploy its build to the sandbox via the repo-owned
 * contract (T-03), then run the shadow gates — envelope (T-02), reviewer
 * (T-05), tiered acceptance-criteria verification (T-04) — aggregate the
 * phase verdict and exception ledger (T-06), persist everything, and halt.
 * Human approval remains the only advance mechanism this phase; the CI
 * gate joins in a later slice.
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
    @inject(WORKFLOW_TOKENS.SandboxDeployService)
    private readonly _sandboxDeploy: ISandboxDeployService,
    @inject(WORKFLOW_TOKENS.VerificationService)
    private readonly _verification: IVerificationService,
    @inject(WORKFLOW_TOKENS.AggregatorService)
    private readonly _aggregator: IAggregatorService,
    @inject(WORKFLOW_TOKENS.GitRepository)
    private readonly _gitRepo: IGitRepository,
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

    // T-03: deploy the task branch build to the sandbox via the repo-owned
    // contract, idempotent per SHA.
    const worktreePath = path.join(
      input.runsDir,
      input.runId,
      'worktrees',
      task.id
    );
    const sandbox = await this._sandboxDeploy.deploy({
      worktreePath,
      sha: this._gitRepo.headSha(worktreePath),
      previous: state.sandbox
    });
    this._runStateRepo.appendVerdict(input.runsDir, state, sandbox.verdict);
    if (sandbox.record !== undefined) {
      this._runStateRepo.recordSandbox(input.runsDir, state, sandbox.record);
    }
    this.printVerdict(sandbox.verdict);

    // T-04: tiered acceptance-criteria verification with attached evidence.
    const verification = await this.runVerification(
      input,
      worktreePath,
      outcome,
      sandbox.healthReport
    );
    this._runStateRepo.appendVerdict(
      input.runsDir,
      state,
      verification.verdict
    );
    this._runStateRepo.recordCriteria(
      input.runsDir,
      state,
      verification.criteria
    );
    this.printVerdict(verification.verdict);

    // The CI gate is not wired yet; the aggregator sees it as blocked so
    // the phase verdict stays honest.
    const pendingGate = (gate: string): GateVerdict => ({
      gate,
      outcome: 'blocked',
      wouldEscalate: false,
      reasons: ['not wired this phase'],
      recordedAt: new Date().toISOString()
    });

    const { verdict: phaseVerdict, exceptions } = this._aggregator.aggregate({
      gates: {
        ci: pendingGate('ci'),
        verification: verification.verdict,
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

  private async runVerification(
    input: RunTaskInput,
    worktreePath: string,
    outcome: ExecutorOutcome,
    healthReport: string | undefined
  ): Promise<VerificationOutcome> {
    const task = outcome.task;
    if (task === undefined) {
      throw new Error('executor returned an incomplete outcome');
    }
    try {
      return await this._verification.verify({
        worktreePath,
        runsDir: input.runsDir,
        runId: input.runId,
        task,
        healthReport
      });
    } catch (err) {
      if (err instanceof WorkflowError && err.code === 'SPEC_MALFORMED') {
        // T-04: an invalid criterion prefix fails validation before any
        // execution — recorded as a blocked verdict, not a crashed run.
        return {
          verdict: {
            gate: 'verification',
            outcome: 'blocked',
            wouldEscalate: true,
            reasons: [err.message],
            recordedAt: new Date().toISOString()
          },
          criteria: []
        };
      }
      throw err;
    }
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
