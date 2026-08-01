import { inject, injectable } from 'inversify';
import chalk from 'chalk';
import path from 'path';
import type { IEvidenceRepository } from '../repositories/evidence.repository';
import type { IGitRepository } from '../repositories/git.repository';
import type { IRunStateRepository } from '../repositories/run-state.repository';
import type { IAggregatorService } from '../services/aggregator.service';
import type { IChronicleCommitService } from '../services/chronicle-commit.service';
import type { ICiGateService } from '../services/ci-gate.service';
import type { IDigestService } from '../services/digest.service';
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
import {
  GateVerdict,
  RunState,
  SpecTask,
  stepKey,
  WorkflowError
} from '../types';
import { inputsDigest } from '../utils/digest';

export interface RunTaskInput extends ExecutorInput {
  /**
   * Path to the personal Chronicle ledger repo. When present, the phase
   * boundary posts a digest to the PRD-0007 queue (T-07) and commits run
   * artifacts (T-08). Absent → both steps are skipped with a notice.
   */
  chronicleRepo?: string;
}

export interface RunTaskResult {
  outcome: ExecutorOutcome['kind'];
  taskId?: string;
  branch?: string;
}

/**
 * SPEC-PRD-0011-P2 single-task loop: execute one ready task in an isolated
 * worktree (T-01), deploy its build to the sandbox via the repo-owned
 * contract (T-03), run the shadow gates — envelope (T-02), reviewer (T-05),
 * tiered verification (T-04), CI check-runs — aggregate the phase verdict
 * and exception ledger (T-06), post the phase-boundary digest to the
 * personal queue (T-07), and commit run artifacts to the Chronicle (T-08).
 *
 * Every step runs through the T-09 step graph: its result is cached under a
 * key derived from an inputs digest rooted at {task content, base SHA} and
 * chained through the worktree head SHA. Kill the run at any boundary and
 * resume replays the graph — cache hits are reused, so agents are not
 * re-invoked, the sandbox is not redeployed, and digests are not re-posted.
 */
export interface RecordMergeCliInput {
  chronicleRepo: string;
  runsDir: string;
  runId: string;
  mergedSha: string;
}

export interface StatusCliInput {
  runsDir: string;
  runId: string;
}

export interface IRunHandler {
  runTask(input: RunTaskInput): Promise<RunTaskResult>;
  /** T-08: record a human-approved merge in the run's Chronicle artifact. */
  recordMerge(input: RecordMergeCliInput): Promise<void>;
  /**
   * T-09 run-status interface: print the run's task results, step graph
   * (what is cached vs would re-execute), verdicts, and exceptions.
   */
  showStatus(input: StatusCliInput): void;
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
    @inject(WORKFLOW_TOKENS.CiGateService)
    private readonly _ciGate: ICiGateService,
    @inject(WORKFLOW_TOKENS.AggregatorService)
    private readonly _aggregator: IAggregatorService,
    @inject(WORKFLOW_TOKENS.DigestService)
    private readonly _digest: IDigestService,
    @inject(WORKFLOW_TOKENS.ChronicleCommitService)
    private readonly _chronicle: IChronicleCommitService,
    @inject(WORKFLOW_TOKENS.GitRepository)
    private readonly _gitRepo: IGitRepository,
    @inject(WORKFLOW_TOKENS.EvidenceRepository)
    private readonly _evidenceRepo: IEvidenceRepository,
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
    if (
      task === undefined ||
      state === null ||
      outcome.branch === undefined ||
      outcome.implDigest === undefined
    ) {
      // Executor contract guarantees these for completed/failed outcomes.
      throw new Error('executor returned an incomplete outcome');
    }

    const icon =
      outcome.kind === 'completed' ? chalk.green('✓') : chalk.red('✗');
    const cachedNote = outcome.cached === true ? ' (cached)' : '';
    console.log(
      `  ${icon} ${task.id} ${outcome.kind}${cachedNote} on ${outcome.branch}`
    );
    if (outcome.detail !== undefined) {
      console.log(chalk.gray(`    ${outcome.detail.slice(0, 300)}`));
    }

    const worktreePath = path.join(
      input.runsDir,
      input.runId,
      'worktrees',
      task.id
    );
    const headSha = this._gitRepo.headSha(worktreePath);
    // Every downstream step chains off the implementation digest, so a spec
    // content edit invalidates exactly this task's steps (T-09).
    const chain = { implDigest: outcome.implDigest, headSha };

    const envelopeVerdict = await this.gateStep(
      input,
      state,
      'envelope',
      task.id,
      inputsDigest({ ...chain, envelope: outcome.spec.envelope }),
      () =>
        this._envelopeGate.evaluate({
          repoPath: input.repoPath,
          baseRef: state.baseSha,
          headRef: outcome.branch as string,
          envelope: outcome.spec.envelope
        })
    );

    const reviewerVerdict = await this.gateStep(
      input,
      state,
      'reviewer',
      task.id,
      inputsDigest({ ...chain, task }),
      async () => {
        const verdict = await this._reviewerGate.review({
          repoPath: input.repoPath,
          baseRef: state.baseSha,
          headRef: outcome.branch as string,
          task,
          envelope: outcome.spec.envelope
        });
        if (verdict.transcript !== undefined) {
          const evidenceId = `${task.id}-reviewer-transcript`;
          this._evidenceRepo.save(
            input.runsDir,
            input.runId,
            evidenceId,
            verdict.transcript
          );
          verdict.evidenceIds = [evidenceId];
        }
        return verdict;
      }
    );

    // T-03: SHA-idempotent sandbox deploy; the step cache additionally
    // guarantees kill-resume produces no duplicate deployments.
    const sandboxOutcome = await this.sandboxStep(
      input,
      state,
      task,
      worktreePath,
      inputsDigest({ ...chain, step: 'sandbox' })
    );

    const verificationVerdict = await this.verificationStep(
      input,
      state,
      task,
      worktreePath,
      sandboxOutcome.healthReport,
      inputsDigest({ ...chain, criteria: task.acceptanceCriteria })
    );

    // The real CI gate: check runs for the task branch head SHA.
    const ciVerdict = await this.gateStep(
      input,
      state,
      'ci',
      task.id,
      inputsDigest({ ...chain, gate: 'ci' }),
      () =>
        this._ciGate.evaluate({
          repoPath: input.repoPath,
          sha: headSha,
          taskId: task.id
        })
    );

    const phaseDigest = inputsDigest({ ...chain, step: 'phase' });
    const phaseKey = stepKey('phase', task.id, phaseDigest);
    let phaseVerdict: GateVerdict;
    if (state.steps[phaseKey]?.verdict !== undefined) {
      phaseVerdict = state.steps[phaseKey].verdict;
      console.log(chalk.gray('  [cached] phase gate reused (step cache)'));
    } else {
      const aggregate = this._aggregator.aggregate({
        gates: {
          ci: ciVerdict,
          verification: verificationVerdict,
          reviewer: reviewerVerdict,
          envelope: envelopeVerdict
        },
        state,
        taskId: task.id,
        budgetK: outcome.spec.envelope.budgetK
      });
      phaseVerdict = aggregate.verdict;
      phaseVerdict.taskId = task.id;
      phaseVerdict.inputsDigest = phaseDigest;
      this._runStateRepo.appendVerdict(input.runsDir, state, phaseVerdict);
      this._runStateRepo.recordExceptions(
        input.runsDir,
        state,
        aggregate.exceptions
      );
      this._runStateRepo.recordStep(input.runsDir, state, phaseKey, {
        name: 'phase',
        taskId: task.id,
        inputsDigest: phaseDigest,
        verdict: phaseVerdict,
        completedAt: new Date().toISOString()
      });
      this.printVerdict(phaseVerdict);
      for (const entry of aggregate.exceptions) {
        console.log(
          chalk.yellow(
            `  [ledger] ${entry.trigger}: ${entry.context.join('; ')}`
          )
        );
      }
    }

    await this.chronicleSteps(input, state, task, outcome, chain, phaseVerdict);

    console.log(chalk.bold('\n[HUMAN GATE] Shadow mode — nothing advances.'));
    console.log(`  Review branch ${outcome.branch} and the recorded verdicts;`);
    console.log(
      '  merging (or not) is your call. Gate enforcement is Phase 3.'
    );

    return { outcome: outcome.kind, taskId: task.id, branch: outcome.branch };
  }

  showStatus(input: StatusCliInput): void {
    const state = this._runStateRepo.load(input.runsDir, input.runId);
    if (state === null) {
      throw new WorkflowError(
        `run ${input.runId} has no recorded state`,
        'RUN_NOT_FOUND'
      );
    }

    console.log(chalk.bold(`\nRun ${state.runId} — ${state.specId}`));
    console.log(
      `  spec: ${state.specPath}\n  base: ${state.baseSha}\n  updated: ${state.updatedAt}`
    );
    if (state.mergedSha !== undefined) {
      console.log(chalk.green(`  merged: ${state.mergedSha}`));
    }

    console.log(chalk.bold('\nTasks'));
    const results = Object.values(state.taskResults);
    if (results.length === 0) console.log('  (none attempted)');
    for (const result of results) {
      const icon =
        result.status === 'completed' ? chalk.green('✓') : chalk.red('✗');
      console.log(
        `  ${icon} ${result.taskId} ${result.status}` +
          (result.branch !== undefined ? ` on ${result.branch}` : '')
      );
    }

    console.log(chalk.bold('\nSteps (cached — reused on resume)'));
    const steps = Object.values(state.steps).sort((a, b) =>
      a.completedAt < b.completedAt ? -1 : 1
    );
    if (steps.length === 0) console.log('  (none completed)');
    for (const step of steps) {
      const outcome =
        step.verdict !== undefined ? ` → ${step.verdict.outcome}` : '';
      console.log(
        `  ${step.taskId} ${step.name}${outcome}` +
          chalk.gray(` [${step.inputsDigest.slice(0, 12)}] ${step.completedAt}`)
      );
    }

    console.log(chalk.bold('\nVerdicts'));
    if (state.verdicts.length === 0) console.log('  (none recorded)');
    for (const verdict of state.verdicts) {
      this.printVerdict(verdict);
    }

    if (state.sandbox !== undefined) {
      console.log(chalk.bold('\nSandbox'));
      console.log(
        `  ${state.sandbox.sha} ${state.sandbox.status} at ${state.sandbox.recordedAt}`
      );
    }

    if (state.exceptions.length > 0) {
      console.log(chalk.bold('\nException ledger'));
      for (const entry of state.exceptions) {
        console.log(
          chalk.yellow(
            `  ${entry.taskId} ${entry.trigger}: ${entry.context.join('; ')}`
          )
        );
      }
    }
  }

  async recordMerge(input: RecordMergeCliInput): Promise<void> {
    const artifactPath = await this._chronicle.recordMerge(input);
    console.log(
      chalk.green(
        `✓ merge ${input.mergedSha.slice(0, 12)} recorded for ${input.runId} (${artifactPath})`
      )
    );
  }

  /**
   * T-07 digest post + T-08 artifact commit, both behind the step cache so
   * resume never double-posts or re-commits.
   */
  private async chronicleSteps(
    input: RunTaskInput,
    state: RunState,
    task: SpecTask,
    outcome: ExecutorOutcome,
    chain: { implDigest?: string; headSha: string },
    phaseVerdict: GateVerdict
  ): Promise<void> {
    if (input.chronicleRepo === undefined) {
      console.log(
        chalk.gray(
          '  [skip] no --chronicle-repo: digest post (T-07) and artifact commit (T-08) skipped'
        )
      );
      return;
    }

    const recordDigest = inputsDigest({ ...chain, step: 'chronicle-record' });
    const recordKey = stepKey('chronicle-record', task.id, recordDigest);
    if (state.steps[recordKey] === undefined) {
      const recorded = await this._chronicle.record({
        chronicleRepo: input.chronicleRepo,
        spec: outcome.spec,
        state
      });
      this._runStateRepo.recordStep(input.runsDir, state, recordKey, {
        name: 'chronicle-record',
        taskId: task.id,
        inputsDigest: recordDigest,
        detail: `${recorded.artifactPaths.length} artifacts`,
        completedAt: new Date().toISOString()
      });
      console.log(
        chalk.gray(
          `  [chronicle] ${recorded.artifactPaths.length} artifacts committed`
        )
      );
    } else {
      console.log(
        chalk.gray('  [cached] chronicle artifacts already committed')
      );
    }

    const postDigest = inputsDigest({ ...chain, step: 'digest-post' });
    const digestKey = stepKey('digest-post', task.id, postDigest);
    if (state.steps[digestKey] === undefined) {
      const posted = await this._digest.post({
        chronicleRepo: input.chronicleRepo,
        runId: input.runId,
        specId: state.specId,
        taskId: task.id,
        phaseVerdict,
        verdicts: state.verdicts.filter(verdict => verdict.taskId === task.id),
        exceptions: state.exceptions.filter(entry => entry.taskId === task.id)
      });
      this._runStateRepo.recordStep(input.runsDir, state, digestKey, {
        name: 'digest-post',
        taskId: task.id,
        inputsDigest: postDigest,
        detail: posted.artifactPath,
        completedAt: new Date().toISOString()
      });
      console.log(
        chalk.gray(
          `  [digest] posted to personal queue (${posted.artifactPath})`
        )
      );
    } else {
      console.log(chalk.gray('  [cached] digest already posted'));
    }
  }

  /**
   * Run a shadow gate through the T-09 step cache: a cached verdict is
   * reused verbatim; otherwise the gate runs, its verdict is stamped with
   * the inputs digest, persisted, and the step recorded.
   */
  private async gateStep(
    input: RunTaskInput,
    state: RunState,
    name: string,
    taskId: string,
    digest: string,
    run: () => Promise<GateVerdict>
  ): Promise<GateVerdict> {
    const key = stepKey(name, taskId, digest);
    const cached = state.steps[key];
    if (cached?.verdict !== undefined) {
      console.log(chalk.gray(`  [cached] ${name} gate reused (step cache)`));
      return cached.verdict;
    }
    const verdict = await run();
    verdict.taskId = taskId;
    verdict.inputsDigest = digest;
    this._runStateRepo.appendVerdict(input.runsDir, state, verdict);
    this._runStateRepo.recordStep(input.runsDir, state, key, {
      name,
      taskId,
      inputsDigest: digest,
      verdict,
      completedAt: new Date().toISOString()
    });
    this.printVerdict(verdict);
    return verdict;
  }

  private async sandboxStep(
    input: RunTaskInput,
    state: RunState,
    task: SpecTask,
    worktreePath: string,
    digest: string
  ): Promise<{ verdict: GateVerdict; healthReport?: string }> {
    const key = stepKey('sandbox', task.id, digest);
    const cached = state.steps[key];
    if (cached?.verdict !== undefined) {
      console.log(chalk.gray('  [cached] sandbox gate reused (step cache)'));
      return { verdict: cached.verdict, healthReport: cached.detail };
    }

    const sandbox = await this._sandboxDeploy.deploy({
      worktreePath,
      sha: this._gitRepo.headSha(worktreePath),
      previous: state.sandbox
    });
    sandbox.verdict.taskId = task.id;
    sandbox.verdict.inputsDigest = digest;
    if (sandbox.healthReport !== undefined) {
      const evidenceId = `${task.id}-sandbox-health`;
      this._evidenceRepo.save(
        input.runsDir,
        input.runId,
        evidenceId,
        sandbox.healthReport
      );
      sandbox.verdict.evidenceIds = [evidenceId];
    }
    this._runStateRepo.appendVerdict(input.runsDir, state, sandbox.verdict);
    if (sandbox.record !== undefined) {
      this._runStateRepo.recordSandbox(input.runsDir, state, sandbox.record);
    }
    this._runStateRepo.recordStep(input.runsDir, state, key, {
      name: 'sandbox',
      taskId: task.id,
      inputsDigest: digest,
      verdict: sandbox.verdict,
      detail: sandbox.healthReport,
      completedAt: new Date().toISOString()
    });
    this.printVerdict(sandbox.verdict);
    return { verdict: sandbox.verdict, healthReport: sandbox.healthReport };
  }

  private async verificationStep(
    input: RunTaskInput,
    state: RunState,
    task: SpecTask,
    worktreePath: string,
    healthReport: string | undefined,
    digest: string
  ): Promise<GateVerdict> {
    const key = stepKey('verification', task.id, digest);
    const cached = state.steps[key];
    if (cached?.verdict !== undefined) {
      console.log(
        chalk.gray('  [cached] verification gate reused (step cache)')
      );
      return cached.verdict;
    }

    const verification = await this.runVerification(
      input,
      worktreePath,
      task,
      healthReport
    );
    verification.verdict.taskId = task.id;
    verification.verdict.inputsDigest = digest;
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
    this._runStateRepo.recordStep(input.runsDir, state, key, {
      name: 'verification',
      taskId: task.id,
      inputsDigest: digest,
      verdict: verification.verdict,
      completedAt: new Date().toISOString()
    });
    this.printVerdict(verification.verdict);
    return verification.verdict;
  }

  private async runVerification(
    input: RunTaskInput,
    worktreePath: string,
    task: SpecTask,
    healthReport: string | undefined
  ): Promise<VerificationOutcome> {
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
