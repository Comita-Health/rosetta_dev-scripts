import { inject, injectable } from 'inversify';
import chalk from 'chalk';
import type { IRunStateRepository } from '../repositories/run-state.repository';
import type { IEnvelopeGateService } from '../services/envelope-gate.service';
import type {
  ExecutorInput,
  ExecutorOutcome,
  IExecutorService
} from '../services/executor.service';
import { WORKFLOW_TOKENS } from '../tokens';

export interface RunTaskInput extends ExecutorInput {}

export interface RunTaskResult {
  outcome: ExecutorOutcome['kind'];
  taskId?: string;
  branch?: string;
}

/**
 * SPEC-PRD-0011-P2 single-task loop, phase-2 slice: execute one ready task
 * in an isolated worktree (T-01), run the envelope gate in shadow mode
 * (T-02), persist everything, and halt — human approval remains the only
 * advance mechanism this phase.
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

    const verdict = await this._envelopeGate.evaluate({
      repoPath: input.repoPath,
      baseRef: state.baseSha,
      headRef: outcome.branch,
      envelope: outcome.spec.envelope
    });
    this._runStateRepo.appendVerdict(input.runsDir, state, verdict);

    const verdictColor = verdict.outcome === 'pass' ? chalk.green : chalk.red;
    console.log(
      verdictColor(
        `  [shadow] envelope gate: ${verdict.outcome}` +
          (verdict.wouldEscalate ? ' (would escalate)' : '')
      )
    );
    for (const reason of verdict.reasons) {
      console.log(chalk.gray(`    - ${reason}`));
    }

    console.log(chalk.bold('\n[HUMAN GATE] Shadow mode — nothing advances.'));
    console.log(`  Review branch ${outcome.branch} and the recorded verdicts;`);
    console.log(
      '  merging (or not) is your call. Gate enforcement is Phase 3.'
    );

    return { outcome: outcome.kind, taskId: task.id, branch: outcome.branch };
  }
}
