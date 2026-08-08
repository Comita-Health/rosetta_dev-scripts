import { inject, injectable } from 'inversify';
import chalk from 'chalk';
import path from 'path';
import type { IEvidenceRepository } from '../repositories/evidence.repository';
import type { IGitRepository } from '../repositories/git.repository';
import type { IQueueRepository } from '../repositories/queue.repository';
import type { IRunQueueRepository } from '../repositories/run-queue.repository';
import type { IRunStateRepository } from '../repositories/run-state.repository';
import type { ISpecDocRepository } from '../repositories/spec-doc.repository';
import type { IAggregatorService } from '../services/aggregator.service';
import type { IChronicleCommitService } from '../services/chronicle-commit.service';
import type { ICiGateService } from '../services/ci-gate.service';
import type { ICloseoutAggregateService } from '../services/closeout-aggregate.service';
import type { ICloseoutService } from '../services/closeout.service';
import type { IDigestService } from '../services/digest.service';
import type { IEnvelopeGateService } from '../services/envelope-gate.service';
import type { IEscalationService } from '../services/escalation.service';
import type { IGateRemediationService } from '../services/gate-remediation.service';
import type {
  ExecutorOutcome,
  IExecutorService,
  PoolInput
} from '../services/executor.service';
import type { IHeartbeatService } from '../services/heartbeat.service';
import type { IPullRequestRepository } from '../repositories/pull-request.repository';
import type { IPrLifecycleService } from '../services/pr-lifecycle.service';
import type { IReviewerGateService } from '../services/reviewer-gate.service';
import type { IReviewerPublishService } from '../services/reviewer-publish.service';
import { isBugSpec } from '../services/retro.service';
import type { IRetroService } from '../services/retro.service';
import type {
  IRetryExecutorService,
  RetryOutcome
} from '../services/retry-executor.service';
import type {
  DeployLedgerRef,
  ISandboxDeployService
} from '../services/sandbox-deploy.service';
import type {
  IVerificationService,
  VerificationOutcome
} from '../services/verification.service';
import { WORKFLOW_TOKENS } from '../tokens';
import {
  CriterionVerdict,
  DeployTrigger,
  ExceptionEntry,
  GateVerdict,
  RecoveryHistory,
  RunState,
  SpecDocument,
  SpecTask,
  stepKey,
  WorkflowError
} from '../types';
import { inputsDigest } from '../utils/digest';
import { appendMonitorLine } from '../utils/monitor';
import { buildQueuedRunArgv } from '../utils/queue-argv';
import { categorizeTasks } from '../utils/run-summary';

export interface RunTaskInput extends PoolInput {
  /**
   * Path to the personal Chronicle ledger repo. When present, the phase
   * boundary posts a digest to the PRD-0007 queue (T-07) and commits run
   * artifacts (T-08). Absent → both steps are skipped with a notice.
   */
  chronicleRepo?: string;
  /**
   * P3 T-04 calibration mode: verdicts are recorded but no merge call is
   * ever issued, regardless of gate outcomes. Default is enforcing.
   */
  shadow?: boolean;
  /**
   * Native progress heartbeat interval in seconds (#39). Default 30;
   * pass 0 to disable. Writes `[heartbeat] {json}` lines and
   * `<runsDir>/<runId>/heartbeat.jsonl`.
   */
  heartbeatSeconds?: number;
  /**
   * GitHub login for needs-human escalation assignees (fail-loud T-04).
   * Consumed at launch via `--operator` / `SDLC_OPERATOR`; never hardcoded.
   */
  operator?: string;
  /**
   * Live monitor log path for loud escalation warnings. Defaults to
   * `<runsDir>/<runId>/monitor.log` when omitted.
   */
  monitorPath?: string;
  /** Override wake-inbox root for tests. */
  wakeDir?: string;
  /**
   * First backoff (ms) between non-gate step retries, doubling per attempt
   * (SPEC-PRD-0021-P1 T-04). `0` disables waiting — used by tests so a retry
   * assertion does not cost real seconds.
   */
  retryBackoffMs?: number;
}

export interface RunTaskResult {
  outcome: 'blocked' | 'no-ready-task' | 'executed';
  tasks: { taskId: string; kind: ExecutorOutcome['kind']; branch: string }[];
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
 * key derived from an inputs digest rooted at {task content, integration tip}
 * and chained through the worktree head SHA. Kill the run at any boundary and
 * resume replays the graph — cache hits are reused, so agents are not
 * re-invoked, the sandbox is not redeployed, and digests are not re-posted.
 * After deps merge, the tip (and envelope/reviewer baseRef) is the post-merge
 * integration SHA — never a cumulative frozen-base mega-diff (#42 / F1).
 */
export interface RecordMergeCliInput {
  chronicleRepo: string;
  runsDir: string;
  runId: string;
  mergedSha: string;
  /** P3 T-01: also mark this task merged, unblocking its dependents. */
  taskId?: string;
  /**
   * Target repo checkout. Optional because older callers/scripts may not
   * pass it, but without it a merge recorded through this CLI path (e.g. a
   * human-approved merge acknowledged by a watcher script) cannot schedule
   * worktree cleanup — only `taskId` alone isn't enough to locate the repo
   * the worktree was created in.
   */
  repoPath?: string;
}

export interface StatusCliInput {
  runsDir: string;
  runId: string;
}

/** T-02: `queue-run` CLI input — the same launch surface as `run`, minus
 * the flags (`--shadow`, `--supervise`, `--detach`) the queued launch
 * always applies itself (`--supervise --detach`, enforcing). */
export interface QueueRunCliInput {
  specPath: string;
  repoPath: string;
  runsDir: string;
  runId?: string;
  chronicleRepo?: string;
  maxParallel?: number;
  heartbeatSeconds?: number;
  maxWaves?: number;
  monitorPath?: string;
  operator?: string;
}

export interface QueueStatusCliInput {
  runsDir: string;
}

/**
 * The minimum an operation needs to find the run's `monitor.log` and deploy
 * ledger. Both the task pipeline and `check-veto` deploy sandboxes, and
 * `check-veto` has no spec or parallelism, so the shared helpers ask for the
 * run identity rather than a whole `RunTaskInput`.
 */
interface MonitorTarget {
  runsDir: string;
  runId: string;
  monitorPath?: string;
}

/**
 * What generating a closeout PR needs (SPEC-PRD-0023-P1 T-02). Narrower than
 * `RunTaskInput` so the `closeout` CLI can drive the same path as the phase
 * boundary — a retroactive closeout is the same operation, not a second
 * implementation of it.
 */
interface CloseoutTarget extends MonitorTarget {
  repoPath: string;
  specPath: string;
  /** Shadow runs never merge, so they never close out. */
  shadow?: boolean;
}

export interface CheckVetoInput {
  runsDir: string;
  runId: string;
  repoPath: string;
  chronicleRepo: string;
}

/** SPEC-PRD-0023-P1: `closeout` CLI input — one spec, one run's verdicts. */
export interface CloseoutCliInput {
  runsDir: string;
  runId: string;
  repoPath: string;
  specPath: string;
}

export interface CheckVetoResult {
  veto: boolean;
  reverted: boolean;
  prUrl?: string;
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
  /**
   * P3 T-05: read the phase digest's queue item; a [veto] tag reverts the
   * phase's merges through a PR and redeploys the sandbox at the reverted
   * SHA. No veto → nothing changes. The run itself never blocks on this.
   */
  checkVeto(input: CheckVetoInput): Promise<CheckVetoResult>;
  /**
   * SPEC-PRD-0023-P1 T-02: generate (or refresh) a spec's closeout PR from a
   * run's recorded verdicts, outside the phase boundary.
   *
   * @remarks
   * Same code path the phase boundary takes, exposed so an interrupted
   * closeout can be re-driven and so specs that landed before this machinery
   * existed can be closed out from their runs. Idempotent by branch: repeated
   * invocations update one PR.
   */
  closeout(input: CloseoutCliInput): Promise<void>;
  /** T-02: write a durable FIFO launch record, deduped by spec path. */
  queueRun(input: QueueRunCliInput): void;
  /** T-02: list queued launch records (`status --queue`). */
  listQueue(input: QueueStatusCliInput): void;
}

@injectable()
export class RunHandler implements IRunHandler {
  /** Labels gate logs `shadow` vs `enforce` (was hard-coded `shadow`). */
  private _gateMode: 'shadow' | 'enforce' = 'enforce';

  constructor(
    @inject(WORKFLOW_TOKENS.ExecutorService)
    private readonly _executor: IExecutorService,
    @inject(WORKFLOW_TOKENS.EnvelopeGateService)
    private readonly _envelopeGate: IEnvelopeGateService,
    @inject(WORKFLOW_TOKENS.ReviewerGateService)
    private readonly _reviewerGate: IReviewerGateService,
    @inject(WORKFLOW_TOKENS.ReviewerPublishService)
    private readonly _reviewerPublish: IReviewerPublishService,
    @inject(WORKFLOW_TOKENS.PrLifecycleService)
    private readonly _prLifecycle: IPrLifecycleService,
    @inject(WORKFLOW_TOKENS.PullRequestRepository)
    private readonly _prRepo: IPullRequestRepository,
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
    @inject(WORKFLOW_TOKENS.RetroService)
    private readonly _retro: IRetroService,
    @inject(WORKFLOW_TOKENS.ChronicleCommitService)
    private readonly _chronicle: IChronicleCommitService,
    @inject(WORKFLOW_TOKENS.GitRepository)
    private readonly _gitRepo: IGitRepository,
    @inject(WORKFLOW_TOKENS.EvidenceRepository)
    private readonly _evidenceRepo: IEvidenceRepository,
    @inject(WORKFLOW_TOKENS.QueueRepository)
    private readonly _queueRepo: IQueueRepository,
    @inject(WORKFLOW_TOKENS.RunQueueRepository)
    private readonly _runQueueRepo: IRunQueueRepository,
    @inject(WORKFLOW_TOKENS.EscalationService)
    private readonly _escalation: IEscalationService,
    @inject(WORKFLOW_TOKENS.RunStateRepository)
    private readonly _runStateRepo: IRunStateRepository,
    @inject(WORKFLOW_TOKENS.SpecDocRepository)
    private readonly _specDocRepo: ISpecDocRepository,
    @inject(WORKFLOW_TOKENS.HeartbeatService)
    private readonly _heartbeat: IHeartbeatService,
    @inject(WORKFLOW_TOKENS.GateRemediationService)
    private readonly _remediation: IGateRemediationService,
    @inject(WORKFLOW_TOKENS.RetryExecutorService)
    private readonly _retry: IRetryExecutorService,
    @inject(WORKFLOW_TOKENS.CloseoutAggregateService)
    private readonly _closeoutAggregate: ICloseoutAggregateService,
    @inject(WORKFLOW_TOKENS.CloseoutService)
    private readonly _closeout: ICloseoutService
  ) {}

  async runTask(input: RunTaskInput): Promise<RunTaskResult> {
    console.log(chalk.bold(`\nRun ${input.runId} — ${input.specPath}\n`));
    this._gateMode = input.shadow === true ? 'shadow' : 'enforce';

    const heartbeatSeconds =
      input.heartbeatSeconds === undefined ? 30 : input.heartbeatSeconds;
    this._heartbeat.start({
      runId: input.runId,
      runsDir: input.runsDir,
      intervalMs: heartbeatSeconds * 1000
    });

    try {
      const poolInput: PoolInput = {
        ...input,
        progress: {
          set: ctx => {
            this._heartbeat.setContext(ctx);
          }
        }
      };
      const pool = await this._executor.executeReady(poolInput);

      if (pool.kind === 'blocked') {
        const intake = [...(pool.state?.verdicts ?? [])]
          .reverse()
          .find(v => v.gate === 'intake');
        const reasons = intake?.reasons ?? [];
        console.log(
          chalk.red(`  ✗ Refused at intake: ${pool.detail ?? 'blocked'}.`)
        );
        for (const reason of reasons) {
          console.log(chalk.red(`    - ${reason}`));
        }
        if (pool.detail === 'unapproved-spec') {
          console.log(
            '  Approve the spec (status: Draft → Approved, ADR-0008) and rerun.'
          );
        } else if (pool.detail === 'spec-not-merged') {
          console.log(
            '  Merge the Approved spec onto the default branch (or sync origin) and rerun.'
          );
        }
        return { outcome: pool.kind, tasks: [] };
      }

      if (pool.kind === 'no-ready-task') {
        console.log(
          chalk.yellow(
            '  No ready task (all done, or blocked on unmerged dependencies).'
          )
        );
        // Resume case: the last task may have merged in a prior invocation
        // with the phase boundary interrupted — replay it (fully cached when
        // it already ran).
        if (pool.state !== null) {
          await this.phaseBoundary(input, pool.state, pool.spec);
        }
        return { outcome: pool.kind, tasks: [] };
      }

      const state = pool.state;
      if (state === null) {
        throw new Error('executor returned an executed pool without state');
      }

      // P3 T-01: implementation fanned out concurrently; the gate pipeline
      // runs per task, sequentially — gates share the sandbox and the
      // primary checkout's git object store.
      for (const outcome of pool.outcomes) {
        const icon =
          outcome.kind === 'completed' ? chalk.green('✓') : chalk.red('✗');
        const cachedNote = outcome.cached ? ' (cached)' : '';
        console.log(
          `  ${icon} ${outcome.task.id} ${outcome.kind}${cachedNote} on ${outcome.branch}`
        );
        if (outcome.detail !== undefined) {
          console.log(chalk.gray(`    ${outcome.detail.slice(0, 300)}`));
        }
        if (outcome.kind === 'completed') {
          await this.taskPipeline(input, state, pool.spec, outcome);
        } else {
          // P3 T-06: a failed task (e.g. budget exhaustion) may have written
          // exception entries without entering the gate pipeline — escalate
          // those so the queue still surfaces them.
          const entries = state.exceptions.filter(
            entry => entry.taskId === outcome.task.id
          );
          // No head SHA to key on — the task never reached the gates. Its
          // implementation digest is the equivalent content discriminator.
          this.postEscalations(
            input,
            state,
            outcome.task.id,
            entries,
            outcome.implDigest
          );
        }
      }

      // P3 T-05: once every task of the phase has merged, deploy the merged
      // default branch to the sandbox and post the phase digest.
      await this.phaseBoundary(input, state, pool.spec);

      if (input.shadow === true) {
        console.log(
          chalk.bold('\n[HUMAN GATE] Shadow mode — nothing advances.')
        );
        console.log('  Review the task branches and the recorded verdicts;');
        console.log('  merging (or not) is your call.');
      } else {
        console.log(
          chalk.bold('\n[ENFORCING] Green gates merged automatically;')
        );
        console.log(
          '  red gates blocked and escalated. Promotion beyond the sandbox'
        );
        console.log('  remains a human decision.');
      }

      return {
        outcome: pool.kind,
        tasks: pool.outcomes.map(outcome => ({
          taskId: outcome.task.id,
          kind: outcome.kind,
          branch: outcome.branch
        }))
      };
    } finally {
      this._heartbeat.stop();
    }
  }

  /**
   * The per-task shadow-gate pipeline of SPEC-PRD-0011-P2: envelope →
   * reviewer → (enforce early-remediate/halt on red) → sandbox →
   * verification → CI → phase aggregate → chronicle/digest, every step
   * through the T-09 cache. Enforce skips sandbox/CI when envelope or
   * reviewer is already non-pass (SPEC-BUG-early-reviewer-remediation-P1).
   */
  private async taskPipeline(
    input: RunTaskInput,
    state: RunState,
    spec: SpecDocument,
    outcome: ExecutorOutcome
  ): Promise<void> {
    const task = outcome.task;
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

    this._heartbeat.setContext({
      taskId: task.id,
      step: 'pr',
      worktreePath,
      lastLine: 'opening task PR'
    });

    // P3 T-02: push the branch and open (or rediscover) the task PR before
    // the gates — the PR is the reviewer-gate and CI-gate subject.
    await this.prStep(
      input,
      state,
      task,
      spec,
      outcome.branch,
      worktreePath,
      chain
    );

    // F1: diff against the task's integration tip (same tip the worktree
    // branched from), not the frozen run baseSha — otherwise merged deps
    // inflate maxDiffLines and blow up the reviewer prompt.
    const gateBaseRef = outcome.baseSha;

    this._heartbeat.setContext({
      taskId: task.id,
      step: 'envelope',
      worktreePath,
      lastLine: `baseRef=${gateBaseRef.slice(0, 12)}`
    });

    const envelopeVerdict = await this.gateStep(
      input,
      state,
      'envelope',
      task.id,
      inputsDigest({ ...chain, envelope: spec.envelope, baseRef: gateBaseRef }),
      () =>
        this._envelopeGate.evaluate({
          repoPath: input.repoPath,
          baseRef: gateBaseRef,
          headRef: outcome.branch,
          envelope: spec.envelope
        })
    );

    this._heartbeat.setContext({
      taskId: task.id,
      step: 'reviewer',
      worktreePath,
      lastLine: 'dispatching reviewer agent'
    });

    const reviewerVerdict = await this.gateStep(
      input,
      state,
      'reviewer',
      task.id,
      inputsDigest({ ...chain, task, baseRef: gateBaseRef }),
      async () => {
        const prUrl = state.taskResults[task.id]?.prUrl;
        const publishBase = {
          repoPath: input.repoPath,
          prUrl,
          headSha: this._gitRepo.headSha(worktreePath),
          runId: input.runId,
          taskId: task.id,
          shadow: input.shadow === true
        };
        // Surfaces reviewer on the PR (commit status + comment). Only runs
        // when the gate is not satisfied from step cache — avoids spam on resume.
        this._reviewerPublish.markPending(publishBase);
        const verdict = await this._reviewerGate.review({
          repoPath: input.repoPath,
          baseRef: gateBaseRef,
          headRef: outcome.branch,
          task,
          envelope: spec.envelope
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
        this._reviewerPublish.publishResult({ ...publishBase, verdict });
        return verdict;
      }
    );

    // SPEC-BUG-early-reviewer-remediation-P1 T-01: never sandbox-deploy (or
    // CI) a tip envelope/reviewer already rejected. Enforce only — shadow
    // keeps today's full gate order and never remediates.
    const earlyGateRed =
      envelopeVerdict.outcome !== 'pass' || reviewerVerdict.outcome !== 'pass';
    if (input.shadow !== true && earlyGateRed) {
      await this.earlyRemediateOrHalt(
        input,
        state,
        task,
        spec,
        worktreePath,
        chain,
        envelopeVerdict,
        reviewerVerdict
      );
      return;
    }

    // T-03: SHA-idempotent sandbox deploy; the step cache additionally
    // guarantees kill-resume produces no duplicate deployments. The
    // test-tier check is logically independent of the deployed sandbox,
    // but both contracts typically begin with a package-manager install in
    // the same worktree — running them concurrently races binary linking
    // (observed: repeated transient `bun install` EEXIST breaches on
    // one-click-spec-approval-2026-08-04, 2 of 3 gate rounds). Sequential
    // on purpose until a safe shared-install contract exists (PRD-0022).
    // Test tier goes first: it is the cheaper command and shortens
    // time-to-red for plain test failures.
    this._heartbeat.setContext({
      taskId: task.id,
      step: 'verification',
      worktreePath,
      lastLine: 'running the test tier'
    });

    const precomputedTestTier = await this._verification.verifyTestTierOnly({
      worktreePath,
      runsDir: input.runsDir,
      runId: input.runId,
      task
    });

    this._heartbeat.setContext({
      taskId: task.id,
      step: 'sandbox',
      worktreePath,
      lastLine: `deploying ${headSha.slice(0, 12)} to the sandbox`
    });

    const sandboxOutcome = await this.sandboxStep(
      input,
      state,
      task,
      worktreePath,
      inputsDigest({ ...chain, step: 'sandbox' }),
      // SPEC-PRD-0011-P4 T-01: the deploy contract scopes itself to what this
      // task actually changed, which is the diff against the tip it branched
      // from — the same base the envelope and reviewer gates judge.
      gateBaseRef
    );

    this._heartbeat.setContext({
      taskId: task.id,
      step: 'verification',
      worktreePath,
      lastLine: 'evaluating acceptance criteria'
    });

    const verificationVerdict = await this.verificationStep(
      input,
      state,
      task,
      worktreePath,
      sandboxOutcome.healthReport,
      inputsDigest({ ...chain, criteria: task.acceptanceCriteria }),
      precomputedTestTier
    );

    this._heartbeat.setContext({
      taskId: task.id,
      step: 'ci',
      worktreePath,
      lastLine: 'waiting on GitHub check runs'
    });

    // P3 T-03: live CI gate — poll the pushed branch's checks to terminal,
    // dispatch bounded fix agents on failure, and consume the post-cycle
    // verdict. The cycle transcript is saved as resolvable evidence.
    const ciVerdict = await this.gateStep(
      input,
      state,
      'ci',
      task.id,
      inputsDigest({ ...chain, gate: 'ci' }),
      async () => {
        const verdict = await this._ciGate.monitor({
          repoPath: input.repoPath,
          worktreePath,
          branch: outcome.branch,
          sha: this._gitRepo.headSha(worktreePath),
          task,
          runsDir: input.runsDir,
          state,
          budgetK: spec.envelope.budgetK
        });
        if (verdict.transcript !== undefined) {
          const evidenceId = `${task.id}-ci-monitor`;
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
          envelope: envelopeVerdict,
          // Wave 0: a failed deploy of a declared sandbox now blocks the
          // merge, so "it merged" finally means "it deployed".
          sandbox: sandboxOutcome.verdict
        },
        state,
        taskId: task.id,
        budgetK: spec.envelope.budgetK
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

      // Wave 0: sandbox/CI/verification-only red still remediates here (no
      // remediable envelope/reviewer finding → skip). Envelope/reviewer red
      // never reaches this path in enforce — see earlyRemediateOrHalt.
      if (
        input.shadow !== true &&
        phaseVerdict.outcome !== 'pass' &&
        (await this.remediationRound(input, state, task, spec, worktreePath, [
          reviewerVerdict,
          envelopeVerdict
        ]))
      ) {
        return;
      }

      // P3 T-06: escalate — action-required queue items, then halt this
      // task (staying unmerged blocks dependents; other tasks continue).
      this.postEscalations(
        input,
        state,
        task.id,
        aggregate.exceptions,
        chain.headSha
      );
    }

    // P3 T-04: enforcement. Green across the board auto-merges; any red
    // gate blocks and escalates. There is no code path that merges on red.
    await this.enforcementStep(input, state, task, chain, phaseVerdict);

    await this.chronicleSteps(input, state, task, spec, chain, phaseVerdict);
  }

  /**
   * SPEC-BUG-early-reviewer-remediation-P1 T-01: on enforce envelope/reviewer
   * non-pass, remediate immediately (when remediable) and never sandbox the
   * red head. Success abandons the pass so re-selection re-gates the new tip;
   * skip/fail escalates and halts without deploying.
   */
  private async earlyRemediateOrHalt(
    input: RunTaskInput,
    state: RunState,
    task: SpecTask,
    spec: SpecDocument,
    worktreePath: string,
    chain: { implDigest?: string; headSha: string },
    envelopeVerdict: GateVerdict,
    reviewerVerdict: GateVerdict
  ): Promise<void> {
    const phaseDigest = inputsDigest({ ...chain, step: 'phase' });
    const phaseKey = stepKey('phase', task.id, phaseDigest);

    // Resume after an earlier early-halt: phase is cached for this head —
    // do not spend another remediation round or fall through to sandbox.
    if (state.steps[phaseKey]?.verdict !== undefined) {
      const phaseVerdict = state.steps[phaseKey].verdict;
      console.log(chalk.gray('  [cached] phase gate reused (step cache)'));
      await this.enforcementStep(input, state, task, chain, phaseVerdict);
      await this.chronicleSteps(input, state, task, spec, chain, phaseVerdict);
      return;
    }

    if (
      await this.remediationRound(input, state, task, spec, worktreePath, [
        reviewerVerdict,
        envelopeVerdict
      ])
    ) {
      return;
    }

    // Skipped/failed remediation — aggregate the remediable reds only.
    // Downstream gates were not run; stub them pass so phase reasons name
    // envelope/reviewer (not invented CI/verification failures).
    const skippedPass = (gate: string): GateVerdict => ({
      gate,
      outcome: 'pass',
      wouldEscalate: false,
      reasons: ['skipped: envelope/reviewer non-pass — sandbox not deployed'],
      recordedAt: new Date().toISOString()
    });
    const aggregate = this._aggregator.aggregate({
      gates: {
        ci: skippedPass('ci'),
        verification: skippedPass('verification'),
        reviewer: reviewerVerdict,
        envelope: envelopeVerdict
      },
      state,
      taskId: task.id,
      budgetK: spec.envelope.budgetK
    });
    const phaseVerdict = aggregate.verdict;
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
        chalk.yellow(`  [ledger] ${entry.trigger}: ${entry.context.join('; ')}`)
      );
    }

    this.postEscalations(
      input,
      state,
      task.id,
      aggregate.exceptions,
      chain.headSha
    );
    await this.enforcementStep(input, state, task, chain, phaseVerdict);
    await this.chronicleSteps(input, state, task, spec, chain, phaseVerdict);
  }

  /**
   * Wave 0: dispatch one bounded gate remediation round. Returns true when
   * a fix landed and the caller must abandon this pass — the verdicts it
   * holds now describe a superseded head SHA, and re-selection will bring
   * the task back for a clean re-gate.
   *
   * @remarks
   * Escalation is deliberately suppressed on a successful remediation:
   * filing a needs-human issue for a finding the engine is actively fixing
   * is exactly the noise that trained the operator to ignore escalations.
   * A skip or a failure falls through to the normal escalation path, so an
   * exhausted budget is still loud.
   */
  private async remediationRound(
    input: RunTaskInput,
    state: RunState,
    task: SpecTask,
    spec: SpecDocument,
    worktreePath: string,
    verdicts: GateVerdict[]
  ): Promise<boolean> {
    const branch = state.taskResults[task.id]?.branch;
    if (branch === undefined) return false;

    this._heartbeat.setContext({
      taskId: task.id,
      step: 'remediation',
      worktreePath,
      lastLine: 'dispatching gate remediation agent'
    });

    const outcome = await this._remediation.remediate({
      worktreePath,
      branch,
      task: task,
      envelope: spec.envelope,
      runsDir: input.runsDir,
      state,
      verdicts,
      budgetK: spec.envelope.budgetK
    });

    if (outcome.kind === 'remediated') {
      const line = `[remediate] ${task.id} ${outcome.detail}`;
      console.log(chalk.yellow(`  ${line}`));
      this.noteMonitor(input, line);
      return true;
    }

    console.log(
      chalk.gray(`  [remediate] ${task.id} ${outcome.kind}: ${outcome.detail}`)
    );
    // A skip is the common, uninteresting case (most red gates have nothing
    // remediable) — keep it out of monitor.log so a spent budget or a
    // failed round stays easy to spot there.
    if (outcome.kind === 'failed') {
      this.noteMonitor(
        input,
        `[remediate] ${task.id} failed: ${outcome.detail}`
      );
    }
    return false;
  }

  /** Append to the run's live monitor log (explicit override, else default). */
  private noteMonitor(input: MonitorTarget, line: string): void {
    appendMonitorLine(
      input.monitorPath ?? path.join(input.runsDir, input.runId, 'monitor.log'),
      line
    );
  }

  /**
   * SPEC-PRD-0021-P1 T-04: run a **non-gate** step through the shared retry
   * executor, so a transient PR-open, sandbox-deploy or Chronicle-commit
   * failure costs a backoff instead of the whole run.
   *
   * @remarks
   * Only a *thrown* error is retried. A gate that returns a red verdict has
   * judged the branch and must be honoured verbatim — retrying a verdict is
   * how a retry layer quietly becomes a gate override, so the executor never
   * sees one. This is also why the sandbox deploy is retried on an exception
   * but not on an unhealthy verdict.
   *
   * Each attempt is logged to `monitor.log` as it happens, because the whole
   * point is that an operator watching a slow step can tell "retrying" from
   * "hung" without attaching to the process.
   */
  private async withRetry<T>(
    input: RunTaskInput,
    recoveryPath: string,
    step: () => Promise<T>
  ): Promise<RetryOutcome<T>> {
    return this._retry.run({
      path: recoveryPath,
      step,
      backoffMs: input.retryBackoffMs,
      onAttemptFailed: attempt =>
        this.noteMonitor(
          input,
          `[retry] ${recoveryPath} attempt ${attempt.attempt} failed: ${(
            attempt.detail ?? ''
          ).slice(0, 200)}`
        ),
      onExhausted: history =>
        this.noteMonitor(
          input,
          `[retry] ${recoveryPath} exhausted after ${
            history.attempts.filter(entry => entry.action === 'attempt').length
          } attempts — escalating`
        )
    });
  }

  /**
   * Every sandbox deploy in the engine resolves its ledger identity here
   * (SPEC-PRD-0022-P1 T-01), so dedup and race avoidance in
   * `SandboxDeployService` see a complete ledger by construction.
   *
   * The key is **tree content**, not commit: a merge commit's SHA always
   * differs from the PR head it merged, so commit comparison called
   * already-live content "not deployed" and paid for the deploy twice.
   *
   * @remarks
   * Returns `undefined` when git cannot resolve the tree, which disables the
   * ledger for that call rather than failing the run — without a content key
   * every deploy simply dispatches as it did before. Trading a redundant
   * deploy for a dead run would be the wrong way round.
   */
  private ledgerRef(
    input: MonitorTarget,
    dispatch: {
      worktreePath: string;
      sha: string;
      trigger: DeployTrigger;
      taskId?: string;
    }
  ): DeployLedgerRef | undefined {
    let contentSha: string;
    try {
      contentSha = this._gitRepo.treeSha(dispatch.worktreePath, dispatch.sha);
    } catch {
      this.noteMonitor(
        input,
        `[deploy] no content SHA for ${dispatch.sha.slice(0, 12)} — deploy dedup disabled for this dispatch`
      );
      return undefined;
    }
    return {
      runsDir: input.runsDir,
      runId: input.runId,
      contentSha,
      trigger: dispatch.trigger,
      taskId: dispatch.taskId
    };
  }

  /**
   * The enforcing phase gate (P3 T-04). Exactly one code path reaches a
   * merge call: enforcing mode AND a pass phase verdict AND a recorded PR.
   * Shadow mode records verdicts and never merges (calibration for new
   * repos). A red verdict records a merge-blocked escalation; the task
   * halts by staying unmerged, which is what blocks its dependents (T-01).
   */
  private async enforcementStep(
    input: RunTaskInput,
    state: RunState,
    task: SpecTask,
    chain: { implDigest?: string; headSha: string },
    phaseVerdict: GateVerdict
  ): Promise<void> {
    if (input.shadow === true) {
      console.log(
        chalk.gray('  [shadow] enforcement off — verdicts recorded, no merge')
      );
      return;
    }

    if (phaseVerdict.outcome !== 'pass') {
      const entries = [
        {
          trigger: 'merge-blocked' as const,
          taskId: task.id,
          context: phaseVerdict.reasons,
          recordedAt: new Date().toISOString()
        }
      ];
      this._runStateRepo.recordExceptions(input.runsDir, state, entries);
      this.postEscalations(input, state, task.id, entries, chain.headSha);
      console.log(
        chalk.red(
          `  [enforce] merge blocked for ${task.id}: ${phaseVerdict.reasons.join('; ')}`
        )
      );
      return;
    }

    const digest = inputsDigest({ ...chain, step: 'merge' });
    const key = stepKey('merge', task.id, digest);
    const cached = state.steps[key];
    if (cached !== undefined) {
      console.log(
        chalk.gray(`  [cached] already merged (${cached.detail ?? 'no SHA'})`)
      );
      return;
    }

    this._heartbeat.setContext({
      taskId: task.id,
      step: 'merge',
      lastLine: 'gates green — merging the task PR'
    });

    const prUrl = state.taskResults[task.id]?.prUrl;
    const prNumber = prUrl?.match(/\/pull\/(\d+)$/)?.[1];
    if (prUrl === undefined || prNumber === undefined) {
      const entries = [
        {
          trigger: 'merge-blocked' as const,
          taskId: task.id,
          context: ['all gates green but no PR is recorded for the task'],
          recordedAt: new Date().toISOString()
        }
      ];
      this._runStateRepo.recordExceptions(input.runsDir, state, entries);
      this.postEscalations(input, state, task.id, entries, chain.headSha);
      console.log(
        chalk.red(`  [enforce] ${task.id} green but has no PR — cannot merge`)
      );
      return;
    }

    try {
      const mergedSha = this._prRepo.merge(input.repoPath, Number(prNumber));
      await this.recordEnforcedMerge(
        input,
        state,
        task,
        key,
        digest,
        prUrl,
        mergedSha
      );
    } catch (err) {
      // Merge-reconciliation fix (SPEC-BUG-fail-loud-run-lifecycle-P1 T-03):
      // a thrown `gh pr merge` is not authoritative. `--delete-branch` exits
      // non-zero when the run worktree still has the branch checked out even
      // though GitHub already created the merge commit. Query actual state
      // before filing merge-blocked; only a confirmed-unmerged PR escalates.
      const reconciled = this.reconcileThrownMerge(
        input.repoPath,
        Number(prNumber)
      );
      if (reconciled !== null) {
        await this.recordEnforcedMerge(
          input,
          state,
          task,
          key,
          digest,
          prUrl,
          reconciled
        );
        console.log(
          chalk.yellow(
            `  [enforce] merge call threw but PR #${prNumber} is merged at ${reconciled.slice(0, 12)} — reconciled`
          )
        );
        return;
      }
      const detail =
        err instanceof WorkflowError
          ? [err.message, ...err.details].join(': ')
          : String(err);
      const entries = [
        {
          trigger: 'merge-blocked' as const,
          taskId: task.id,
          context: [`merge call failed: ${detail.slice(0, 500)}`],
          recordedAt: new Date().toISOString()
        }
      ];
      this._runStateRepo.recordExceptions(input.runsDir, state, entries);
      this.postEscalations(input, state, task.id, entries, chain.headSha);
      console.log(
        chalk.red(
          `  [enforce] merge failed for ${task.id}: ${detail.slice(0, 300)}`
        )
      );
    }
  }

  /**
   * After a thrown merge call, ask GitHub whether the PR actually landed.
   * Returns the merge commit OID when confirmed merged; null when the PR
   * is unmerged or the view itself fails (treat as unconfirmed → escalate).
   */
  private reconcileThrownMerge(
    repoPath: string,
    prNumber: number
  ): string | null {
    try {
      return this._prRepo.mergeCommitOid(repoPath, prNumber);
    } catch {
      return null;
    }
  }

  /**
   * Persist a confirmed merge: fetch the remote SHA, record task + run tip,
   * cache the merge step, optionally Chronicle, then schedule worktree cleanup.
   */
  private async recordEnforcedMerge(
    input: RunTaskInput,
    state: RunState,
    task: SpecTask,
    key: string,
    digest: string,
    prUrl: string,
    mergedSha: string
  ): Promise<void> {
    // Bring the merge commit into the local object store before the next
    // wave's worktree add (Phase 0b: gh merge SHA is remote-only).
    this._gitRepo.fetch(input.repoPath);
    this._runStateRepo.recordTaskMerged(
      input.runsDir,
      state,
      task.id,
      mergedSha
    );
    this._runStateRepo.recordMergedSha(input.runsDir, state, mergedSha);
    this._runStateRepo.recordStep(input.runsDir, state, key, {
      name: 'merge',
      taskId: task.id,
      inputsDigest: digest,
      detail: mergedSha,
      completedAt: new Date().toISOString()
    });
    if (input.chronicleRepo !== undefined) {
      // The sdlc.merge.v1 artifact, attributed to the machine gates.
      await this._chronicle.recordMerge({
        chronicleRepo: input.chronicleRepo,
        runsDir: input.runsDir,
        runId: input.runId,
        mergedSha,
        taskId: task.id,
        approvedBy: 'machine-gates'
      });
    }
    console.log(
      chalk.green(
        `  [enforce] all gates green — merged ${prUrl} at ${mergedSha.slice(0, 12)}`
      )
    );
    this.scheduleWorktreeCleanup(input, task.id);
  }

  /**
   * Fire-and-forget: once a task's PR has actually landed on the default
   * branch, its worktree has done its job and is pure disk-space debt.
   * Dispatched via {@link IGitRepository.removeWorktreeAsync} and never
   * awaited — a stuck or failed removal must not block run progress or
   * turn a landed merge into a reported failure (the same principle as
   * the merge-reconciliation fix: a completed side effect is never undone
   * by best-effort cleanup around it). Only call this after the merge is
   * confirmed; a worktree still holds the only checkout of an unmerged
   * branch.
   */
  private scheduleWorktreeCleanup(
    input: { runsDir: string; runId: string; repoPath: string },
    taskId: string
  ): void {
    const worktreePath = path.join(
      input.runsDir,
      input.runId,
      'worktrees',
      taskId
    );
    console.log(
      chalk.gray(`  [cleanup] removing worktree for ${taskId} (background)`)
    );
    this._gitRepo.removeWorktreeAsync(input.repoPath, worktreePath);
  }

  /**
   * P3 T-06 / fail-loud T-04: post action-required queue items, assigned
   * needs-human GitHub issues, and durable wake-inbox events for every
   * exception entry. Evidence IDs are gathered from the task's recorded
   * verdicts so the queue item alone is enough to triage.
   */
  private postEscalations(
    input: RunTaskInput,
    state: RunState,
    taskId: string,
    entries: ExceptionEntry[],
    occurrenceKey?: string
  ): void {
    if (entries.length === 0) return;
    const evidenceIds = state.verdicts
      .filter(verdict => verdict.taskId === taskId)
      .flatMap(verdict => verdict.evidenceIds ?? []);
    const monitorPath =
      input.monitorPath ?? path.join(input.runsDir, input.runId, 'monitor.log');
    const outcome = this._escalation.post({
      chronicleRepo: input.chronicleRepo,
      runId: input.runId,
      entries,
      evidenceIds,
      repoPath: input.repoPath,
      operator: input.operator,
      monitorPath,
      // Wave 0: recurrence of the same escalation against a *new* task head
      // must wake the human again — a resume against unchanged content must
      // not. The head SHA is exactly that discriminator.
      occurrenceKey,
      wakeDir: input.wakeDir
    });
    for (const title of outcome.posted) {
      console.log(chalk.yellow(`  [escalate] ${title}`));
    }
  }

  /**
   * P3 T-05 phase boundary: when every task of the spec phase has a merged
   * SHA, deploy the merged default branch to the sandbox (repo-owned
   * contract, SHA-idempotent, step-cached so resume never redeploys) and
   * post the phase digest — links to every merged SHA and the recorded
   * verdict evidence — to the PRD-0007 queue. The veto is non-blocking:
   * the run advances immediately; `check-veto` reads the item later.
   */
  private async phaseBoundary(
    input: RunTaskInput,
    state: RunState,
    spec: SpecDocument
  ): Promise<void> {
    const merges = spec.tasks.map(task => ({
      taskId: task.id,
      mergedSha: state.taskResults[task.id]?.mergedSha
    }));
    if (!merges.every(entry => entry.mergedSha !== undefined)) {
      return;
    }
    const mergedShas = merges.map(entry => entry.mergedSha as string);
    const digest = inputsDigest({ step: 'phase-boundary', mergedShas });

    // Deploy the merged default branch, exactly once per merge set.
    const deployKey = stepKey('phase-deploy', 'phase', digest);
    if (state.steps[deployKey] !== undefined) {
      console.log(
        chalk.gray(
          `  [cached] phase already deployed (${state.steps[deployKey].detail ?? ''})`
        )
      );
    } else {
      this._gitRepo.fetch(input.repoPath);
      const defaultBranch = this._gitRepo.defaultBranch(input.repoPath);
      const sha = this._gitRepo.resolveSha(
        input.repoPath,
        `origin/${defaultBranch}`
      );
      const worktreePath = path.join(
        input.runsDir,
        input.runId,
        'worktrees',
        '_phase'
      );
      this._gitRepo.addWorktree(
        input.repoPath,
        worktreePath,
        `sdlc/${input.runId}/phase-deploy`,
        sha
      );
      const outcome = await this._sandboxDeploy.deploy({
        worktreePath,
        sha,
        // The phase deploy delivers everything the wave merged, so its scope
        // is the diff from the tip the run started at (SPEC-PRD-0011-P4 T-01).
        baseSha: state.baseSha,
        previous: state.sandbox,
        ledger: this.ledgerRef(input, {
          worktreePath,
          sha,
          trigger: 'phase-boundary',
          taskId: 'phase'
        })
      });
      outcome.verdict.taskId = 'phase';
      outcome.verdict.inputsDigest = digest;
      this._runStateRepo.appendVerdict(input.runsDir, state, outcome.verdict);
      if (outcome.record !== undefined) {
        this._runStateRepo.recordSandbox(input.runsDir, state, outcome.record);
      }
      this.printVerdict(outcome.verdict);
      if (outcome.verdict.outcome !== 'pass') {
        // Leave the step unrecorded so the next invocation retries.
        return;
      }
      this._runStateRepo.recordStep(input.runsDir, state, deployKey, {
        name: 'phase-deploy',
        taskId: 'phase',
        inputsDigest: digest,
        detail: sha,
        completedAt: new Date().toISOString()
      });
      console.log(
        chalk.green(
          `  [phase] merged ${defaultBranch} deployed to sandbox at ${sha.slice(0, 12)}`
        )
      );
    }

    // SPEC-PRD-0023-P1 T-02: the final task of the phase has merged, so the
    // closeout PR is derived and opened (or refreshed) before the digest —
    // which then links it (T-05).
    const closeoutPrUrl = await this.closeoutStep(input, spec);

    // Post the phase digest with the merged SHAs and verdict evidence.
    if (input.chronicleRepo === undefined) {
      console.log(
        chalk.gray('  [skip] no --chronicle-repo — phase digest not posted')
      );
      return;
    }
    // T-05: whether a closeout PR exists is part of the digest's inputs, so a
    // phase digest posted before the closeout landed is re-posted once the
    // link exists instead of staying cached without it. Re-posting writes the
    // same artifact path and the queue dedupes the item, so this costs a file
    // rewrite, not a duplicate.
    const digestInputs = inputsDigest({
      step: 'phase-digest',
      mergedShas,
      closeout: closeoutPrUrl ?? null
    });
    const digestKey = stepKey('phase-digest', 'phase', digestInputs);
    if (state.steps[digestKey] !== undefined) {
      console.log(chalk.gray('  [cached] phase digest already posted'));
      await this.maybeRetroStep(input, state, spec, digest);
      return;
    }
    const posted = await this._digest.post({
      chronicleRepo: input.chronicleRepo,
      runId: input.runId,
      specId: spec.id,
      taskId: 'phase',
      phaseVerdict: {
        gate: 'phase',
        outcome: 'pass',
        wouldEscalate: false,
        reasons: [
          `all ${merges.length} tasks merged: ${mergedShas
            .map(sha => sha.slice(0, 12))
            .join(', ')}`
        ],
        recordedAt: new Date().toISOString()
      },
      verdicts: state.verdicts,
      exceptions: state.exceptions,
      merges: merges as Array<{ taskId: string; mergedSha: string }>,
      ...(closeoutPrUrl !== undefined ? { closeoutPrUrl } : {})
    });
    this._runStateRepo.recordStep(input.runsDir, state, digestKey, {
      name: 'phase-digest',
      taskId: 'phase',
      inputsDigest: digestInputs,
      detail: posted.artifactPath,
      completedAt: new Date().toISOString()
    });
    console.log(
      chalk.green(
        `  [phase] digest posted to queue (${posted.artifactPath}) — veto via [veto] tag`
      )
    );

    // SPEC-BUG-retro-and-queued-plans-P1 T-01: same trigger as the digest
    // above, restricted to BUG-* runs.
    await this.maybeRetroStep(input, state, spec, digest);
  }

  /**
   * SPEC-PRD-0023-P1 T-02 / T-03: derive and publish the phase's closeout PR
   * once every task has merged. Returns the PR URL when one exists, which is
   * what the digest links (T-05).
   *
   * @remarks
   * Not step-cached, deliberately. The generator is idempotent by branch — it
   * updates the same PR number rather than opening a second one — and the
   * verdict set it derives from keeps changing while the phase finishes, so
   * caching would freeze the closeout at whatever the first invocation
   * happened to see. Shadow runs are skipped: they never merge for real, so
   * there is nothing to close out.
   *
   * Failure is never fatal to the run. A closeout that cannot be generated
   * (spec not on the default branch, `gh` refusing, verdicts unreadable)
   * leaves a loud monitor line and no link — and because
   * {@link phaseComplete} requires the PR, the phase then reports incomplete
   * instead of quietly claiming otherwise.
   */
  private async closeoutStep(
    input: CloseoutTarget,
    spec: SpecDocument
  ): Promise<string | undefined> {
    if (input.shadow === true) {
      console.log(
        chalk.gray('  [skip] shadow run — no closeout PR (nothing merged)')
      );
      return undefined;
    }

    const specRelPath = path.relative(input.repoPath, input.specPath);
    if (specRelPath.startsWith('..') || path.isAbsolute(specRelPath)) {
      this.noteMonitor(
        input,
        `[closeout] spec ${input.specPath} is outside ${input.repoPath} — closeout skipped`
      );
      return undefined;
    }

    try {
      const aggregate = this._closeoutAggregate.aggregate({
        runsDir: input.runsDir,
        runId: input.runId,
        spec
      });
      const outcome = await this._closeout.generate({
        repoPath: input.repoPath,
        runsDir: input.runsDir,
        runId: input.runId,
        spec,
        specRelPath: specRelPath.split(path.sep).join('/'),
        aggregate
      });

      if (outcome.pr === undefined) {
        this.noteMonitor(
          input,
          `[closeout] no closeout PR for ${spec.id} (${outcome.kind}): ${outcome.detail ?? 'no detail'}`
        );
        console.log(
          chalk.yellow(
            `  [closeout] ${outcome.kind} — ${outcome.detail ?? 'no closeout PR'}`
          )
        );
        return undefined;
      }

      const status =
        outcome.statusWritten === undefined
          ? 'status unchanged'
          : `status: ${outcome.statusWritten}`;
      console.log(
        chalk.green(
          `  [closeout] ${outcome.kind} ${outcome.pr.url} — ` +
            `${outcome.tickedCount} criteria ticked, ${outcome.remainderCount} remaining, ${status}`
        )
      );
      this.noteMonitor(
        input,
        `[closeout] ${outcome.kind} ${outcome.pr.url} for ${spec.id} (${status})`
      );
      return outcome.pr.url;
    } catch (err) {
      const detail =
        err instanceof WorkflowError
          ? [err.message, ...err.details].join(': ')
          : err instanceof Error
            ? err.message
            : String(err);
      this.noteMonitor(
        input,
        `[closeout] WARNING: closeout generation failed for ${spec.id} — the phase will report incomplete: ${detail.slice(0, 500)}`
      );
      console.log(chalk.red(`  [closeout] failed: ${detail.slice(0, 300)}`));
      return undefined;
    }
  }

  async closeout(input: CloseoutCliInput): Promise<void> {
    const spec = this._specDocRepo.read(input.specPath);
    const url = await this.closeoutStep(input, spec);
    if (url === undefined) {
      console.log(
        chalk.yellow(
          `  No closeout PR for ${spec.id} — see the monitor log for why.`
        )
      );
      return;
    }
    console.log(chalk.green(`  Closeout PR for ${spec.id}: ${url}`));
  }

  /** SPEC-BUG-retro-and-queued-plans-P1 T-01: dispatch the retro only for `BUG-*` specs. */
  private async maybeRetroStep(
    input: RunTaskInput,
    state: RunState,
    spec: SpecDocument,
    digest: string
  ): Promise<void> {
    if (isBugSpec(spec.id) && input.chronicleRepo !== undefined) {
      await this.retroStep(input, state, spec, digest, input.chronicleRepo);
    }
  }

  /** Step-cached retro dispatch; inference failure warns to `monitor.log` without blocking the run. */
  private async retroStep(
    input: RunTaskInput,
    state: RunState,
    spec: SpecDocument,
    digest: string,
    chronicleRepo: string
  ): Promise<void> {
    const retroKey = stepKey('retro', 'phase', digest);
    if (state.steps[retroKey] !== undefined) {
      console.log(chalk.gray('  [cached] bug-run retro already posted'));
      return;
    }

    try {
      const posted = await this._retro.post({
        chronicleRepo,
        runId: input.runId,
        specId: spec.id,
        context: spec.context ?? '',
        verdicts: state.verdicts,
        exceptions: state.exceptions
      });
      this._runStateRepo.recordStep(input.runsDir, state, retroKey, {
        name: 'retro',
        taskId: 'phase',
        inputsDigest: digest,
        detail: posted.artifactPath,
        completedAt: new Date().toISOString()
      });
      console.log(
        chalk.green(
          `  [retro] bug-run retro posted to queue (${posted.artifactPath})`
        )
      );
    } catch (err) {
      const detail =
        err instanceof WorkflowError
          ? [err.message, ...err.details].join(': ')
          : err instanceof Error
            ? err.message
            : String(err);
      const monitorPath =
        input.monitorPath ??
        path.join(input.runsDir, input.runId, 'monitor.log');
      appendMonitorLine(
        monitorPath,
        `[retro] WARNING: bug-run retro inference failed — run completed without it: ${detail.slice(0, 500)}`
      );
      console.log(
        chalk.yellow(
          `  [retro] WARNING: retro inference failed: ${detail.slice(0, 300)}`
        )
      );
    }
  }

  async checkVeto(input: CheckVetoInput): Promise<CheckVetoResult> {
    const state = this._runStateRepo.load(input.runsDir, input.runId);
    if (state === null) {
      throw new WorkflowError(
        `run ${input.runId} has no recorded state`,
        'RUN_NOT_FOUND'
      );
    }

    const merged = Object.values(state.taskResults)
      .filter(result => result.mergedSha !== undefined)
      .sort((a, b) => a.recordedAt.localeCompare(b.recordedAt));
    if (merged.length === 0) {
      console.log(
        chalk.yellow('  Nothing merged in this run — no veto surface.')
      );
      return { veto: false, reverted: false };
    }

    const tags =
      this._queueRepo.itemTags(
        input.chronicleRepo,
        `Review SDLC digest ${input.runId} phase`
      ) ?? [];
    if (!tags.includes('veto')) {
      console.log(
        chalk.green('  No [veto] tag on the phase digest item — nothing to do.')
      );
      return { veto: false, reverted: false };
    }

    const mergedShas = merged.map(result => result.mergedSha as string);
    // T-02: the reverted tasks' gate verdicts, annotated `vetoed` on the
    // Chronicle so per-gate precision is computable from the ledger.
    const revertedTaskIds = new Set(merged.map(result => result.taskId));
    const revertedVerdicts = state.verdicts.filter(
      verdict =>
        verdict.taskId !== undefined && revertedTaskIds.has(verdict.taskId)
    );
    const digest = inputsDigest({ step: 'revert', mergedShas });
    const key = stepKey('revert', 'phase', digest);
    const cached = state.steps[key];
    if (cached !== undefined) {
      console.log(
        chalk.gray(`  [cached] veto already reverted (${cached.detail ?? ''})`)
      );
      return { veto: true, reverted: true, prUrl: cached.detail };
    }

    // Revert branch from the merged default branch head; most recent
    // merge reverted first so each revert applies cleanly.
    this._gitRepo.fetch(input.repoPath);
    const defaultBranch = this._gitRepo.defaultBranch(input.repoPath);
    const baseSha = this._gitRepo.resolveSha(
      input.repoPath,
      `origin/${defaultBranch}`
    );
    const branch = `sdlc/${input.runId}/revert`;
    const worktreePath = path.join(
      input.runsDir,
      input.runId,
      'worktrees',
      '_revert'
    );
    this._gitRepo.addWorktree(input.repoPath, worktreePath, branch, baseSha);
    for (const sha of [...mergedShas].reverse()) {
      this._gitRepo.revertMerge(worktreePath, sha);
    }
    const revertSha = this._gitRepo.headSha(worktreePath);

    this._gitRepo.push(worktreePath, branch);
    const existing = this._prRepo.findByBranch(worktreePath, branch);
    const pr =
      existing ??
      this._prRepo.create(worktreePath, {
        branch,
        title: `revert(sdlc): ${input.runId} phase merges (queue veto)`,
        body: [
          '## Summary',
          '',
          `Veto expressed on the phase digest queue item for run \`${input.runId}\`.`,
          'Reverts the phase\u2019s merge commits:',
          '',
          ...mergedShas.map(sha => `- ${sha}`),
          '',
          `Sandbox redeployed at the reverted SHA. Generated by sdlc-workflow check-veto (PRD-0011 P3 T-05).`
        ].join('\n')
      });

    // Redeploy the sandbox at the reverted state — sandbox only, same
    // repo-owned contract as every other deploy.
    const outcome = await this._sandboxDeploy.deploy({
      worktreePath,
      sha: revertSha,
      baseSha,
      previous: state.sandbox,
      ledger: this.ledgerRef(input, {
        worktreePath,
        sha: revertSha,
        trigger: 'merge',
        taskId: 'phase-revert'
      })
    });
    outcome.verdict.taskId = 'phase-revert';
    this._runStateRepo.appendVerdict(input.runsDir, state, outcome.verdict);
    if (outcome.record !== undefined) {
      this._runStateRepo.recordSandbox(input.runsDir, state, outcome.record);
    }
    this.printVerdict(outcome.verdict);

    await this._chronicle.recordRevert({
      chronicleRepo: input.chronicleRepo,
      runId: input.runId,
      specId: state.specId,
      revertedShas: mergedShas,
      revertSha,
      prUrl: pr.url,
      revertedVerdicts
    });

    this._runStateRepo.recordStep(input.runsDir, state, key, {
      name: 'revert',
      taskId: 'phase',
      inputsDigest: digest,
      detail: pr.url,
      completedAt: new Date().toISOString()
    });
    console.log(
      chalk.yellow(
        `  [veto] reverted ${mergedShas.length} merge(s) — ${pr.url}; sandbox redeployed at ${revertSha.slice(0, 12)}`
      )
    );
    return { veto: true, reverted: true, prUrl: pr.url };
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
    if (state.startedAt !== undefined) {
      console.log(`  started: ${state.startedAt}`);
    }
    if (state.specDigest !== undefined && state.specDigest.length > 0) {
      console.log(`  digest: ${state.specDigest.slice(0, 12)}`);
    }
    if (state.mergedSha !== undefined) {
      console.log(chalk.green(`  merged: ${state.mergedSha}`));
    }

    // P3 T-06: categorize every task so a partially-failed run surfaces
    // exactly what needs human attention (merged / halted-escalated /
    // blocked-by-dependency / …).
    const categorized = (() => {
      try {
        return categorizeTasks(this._specDocRepo.read(state.specPath), state);
      } catch {
        // Spec file moved — fall back to the recorded task results alone.
        return Object.values(state.taskResults).map(result => ({
          taskId: result.taskId,
          title: result.taskId,
          category: (result.mergedSha !== undefined
            ? 'merged'
            : result.status === 'failed'
              ? 'failed'
              : 'completed-unmerged') as
            'merged' | 'failed' | 'completed-unmerged',
          detail: result.mergedSha ?? result.detail
        }));
      }
    })();

    console.log(chalk.bold('\nTasks'));
    if (categorized.length === 0) console.log('  (none)');
    for (const entry of categorized) {
      const colour =
        entry.category === 'merged'
          ? chalk.green
          : entry.category === 'halted-escalated' || entry.category === 'failed'
            ? chalk.red
            : entry.category === 'blocked-by-dependency'
              ? chalk.yellow
              : chalk.gray;
      console.log(
        colour(
          `  ${entry.taskId} ${entry.category}` +
            (entry.detail !== undefined ? ` — ${entry.detail}` : '') +
            ` (${entry.title})`
        )
      );
    }
    console.log(
      chalk.gray(
        `  spend: ${state.tokenSpendK}k tokens` +
          (state.mergedSha !== undefined
            ? ` · last merge ${state.mergedSha.slice(0, 12)}`
            : '')
      )
    );

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

  /**
   * T-02: write (or dedup) a durable FIFO launch record under
   * `<runsDir>/queue/<n>.json`. The stored argv replays `run --supervise
   * --detach` for this spec — the same relaunch mechanics the continuity
   * daemon already uses — so the completing supervise loop (or, later, the
   * PRD-0020 daemon) can launch it with nothing else on hand.
   */
  queueRun(input: QueueRunCliInput): void {
    const specPath = path.resolve(input.specPath);
    const repoPath = path.resolve(input.repoPath);
    const argv = buildQueuedRunArgv({
      scriptEntry: process.argv[1] ?? 'src/index.ts',
      specPath,
      repoPath,
      runsDir: input.runsDir,
      runId: input.runId,
      chronicleRepo: input.chronicleRepo,
      maxParallel: input.maxParallel,
      heartbeatSeconds: input.heartbeatSeconds,
      maxWaves: input.maxWaves,
      monitorPath: input.monitorPath,
      operator: input.operator
    });

    const result = this._runQueueRepo.enqueue(input.runsDir, {
      specPath,
      repoPath,
      runsDir: input.runsDir,
      runId: input.runId,
      argv,
      execArgv: [...process.execArgv],
      execPath: process.execPath,
      cwd: process.cwd()
    });

    if (result.deduped) {
      console.log(
        chalk.yellow(
          `  [queue] already queued (dedup by spec path): ${specPath}`
        )
      );
      console.log(`  record: ${result.path}`);
      return;
    }
    console.log(chalk.green(`✓ queued run #${result.seq} for ${specPath}`));
    console.log(`  repo:   ${repoPath}`);
    console.log(`  record: ${result.path}`);
    console.log(
      chalk.gray(
        '  Launched when the current supervised run completes and this spec is Approved.'
      )
    );
  }

  /** T-02: `status --queue` — list queued launch records, oldest first. */
  listQueue(input: QueueStatusCliInput): void {
    const entries = this._runQueueRepo.list(input.runsDir);
    console.log(chalk.bold(`\nQueued runs (${entries.length})`));
    if (entries.length === 0) {
      console.log('  (empty)');
      return;
    }
    for (const { seq, record } of entries) {
      console.log(
        `  #${seq} ${record.specPath} → ${record.repoPath}` +
          (record.runId !== undefined ? ` (run-id: ${record.runId})` : '') +
          chalk.gray(` queued ${record.queuedAt}`)
      );
    }
  }

  async recordMerge(input: RecordMergeCliInput): Promise<void> {
    const artifactPath = await this._chronicle.recordMerge(input);
    console.log(
      chalk.green(
        `✓ merge ${input.mergedSha.slice(0, 12)} recorded for ${input.runId} (${artifactPath})`
      )
    );
    if (input.taskId !== undefined && input.repoPath !== undefined) {
      this.scheduleWorktreeCleanup(
        {
          runsDir: input.runsDir,
          runId: input.runId,
          repoPath: input.repoPath
        },
        input.taskId
      );
    }
  }

  /**
   * P3 T-02: push the task branch and open its PR through the step cache.
   * Success records the step (resume reuses the PR URL); failure records a
   * blocked `pr` verdict with the tool output and leaves the step
   * unrecorded so the next invocation retries — run state stays intact
   * either way, and the pipeline continues so the remaining gates still
   * report honestly (CI will be blocked without a pushed branch).
   */
  private async prStep(
    input: RunTaskInput,
    state: RunState,
    task: SpecTask,
    spec: SpecDocument,
    branch: string,
    worktreePath: string,
    chain: { implDigest?: string; headSha: string }
  ): Promise<void> {
    const digest = inputsDigest({ ...chain, step: 'pr' });
    const key = stepKey('pr', task.id, digest);
    const cached = state.steps[key];
    if (cached !== undefined) {
      console.log(
        chalk.gray(`  [cached] PR already open (${cached.detail ?? 'no URL'})`)
      );
      return;
    }

    // T-04: `openTaskPr` is find-or-create, so an attempt that pushed but
    // failed before the PR call is resumed rather than duplicated — the
    // retry finds the branch's existing PR instead of opening a second one.
    const attempt = await this.withRetry(input, `pr:${task.id}`, async () =>
      this._prLifecycle.openTaskPr({
        worktreePath,
        branch,
        runId: input.runId,
        spec,
        task,
        verdicts: state.verdicts.filter(verdict => verdict.taskId === task.id)
      })
    );

    if (attempt.kind === 'exhausted') {
      const detail =
        attempt.error instanceof WorkflowError
          ? [attempt.error.message, ...attempt.error.details].join(': ')
          : attempt.error.message;
      this._runStateRepo.appendVerdict(input.runsDir, state, {
        gate: 'pr',
        outcome: 'blocked',
        wouldEscalate: true,
        reasons: [detail.slice(0, 500)],
        recordedAt: new Date().toISOString(),
        taskId: task.id,
        inputsDigest: digest
      });
      console.log(
        chalk.red(
          `  [pr] push/PR failed for ${branch}: ${detail.slice(0, 300)}`
        )
      );
      return;
    }

    const pr = attempt.value;
    this._runStateRepo.recordTaskPrUrl(input.runsDir, state, task.id, pr.url);
    this._runStateRepo.recordStep(input.runsDir, state, key, {
      name: 'pr',
      taskId: task.id,
      inputsDigest: digest,
      detail: pr.url,
      recovery: retried(attempt.history),
      completedAt: new Date().toISOString()
    });
    console.log(
      chalk.green(
        `  [pr] ${pr.created ? 'opened' : 'reusing'} ${pr.url} for ${branch}`
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
    spec: SpecDocument,
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
      // T-04: a Chronicle commit is a git push against a separate ledger
      // repo — the most network-flaky step in the pipeline, and one whose
      // failure used to cost the whole task. Re-committing an already
      // written artifact is a no-op on a clean tree, so retrying is safe.
      const attempt = await this.withRetry(
        input,
        `chronicle-record:${task.id}`,
        async () =>
          this._chronicle.record({
            chronicleRepo: input.chronicleRepo as string,
            spec,
            state
          })
      );
      if (attempt.kind === 'exhausted') {
        console.log(
          chalk.red(
            `  [chronicle] artifact commit failed after retries: ${attempt.error.message.slice(0, 300)}`
          )
        );
      } else {
        const recorded = attempt.value;
        this._runStateRepo.recordStep(input.runsDir, state, recordKey, {
          name: 'chronicle-record',
          taskId: task.id,
          inputsDigest: recordDigest,
          detail: `${recorded.artifactPaths.length} artifacts`,
          recovery: retried(attempt.history),
          completedAt: new Date().toISOString()
        });
        console.log(
          chalk.gray(
            `  [chronicle] ${recorded.artifactPaths.length} artifacts committed`
          )
        );
      }
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
    digest: string,
    baseSha?: string
  ): Promise<{ verdict: GateVerdict; healthReport?: string }> {
    const key = stepKey('sandbox', task.id, digest);
    const cached = state.steps[key];
    if (cached?.verdict !== undefined) {
      console.log(chalk.gray('  [cached] sandbox gate reused (step cache)'));
      return { verdict: cached.verdict, healthReport: cached.detail };
    }

    // T-04: only a *thrown* deploy error is retried. An unhealthy sandbox
    // returns a red verdict, and re-running the deploy to see if the gate
    // changes its mind would make the sandbox gate advisory.
    const attempt = await this.withRetry(
      input,
      `sandbox:${task.id}`,
      async () => {
        const sha = this._gitRepo.headSha(worktreePath);
        return this._sandboxDeploy.deploy({
          worktreePath,
          sha,
          baseSha,
          previous: state.sandbox,
          ledger: this.ledgerRef(input, {
            worktreePath,
            sha,
            trigger: 'task',
            taskId: task.id
          })
        });
      }
    );
    if (attempt.kind === 'exhausted') {
      const verdict: GateVerdict = {
        gate: 'sandbox',
        outcome: 'blocked',
        wouldEscalate: true,
        reasons: [
          `sandbox deploy failed after retries: ${attempt.error.message.slice(0, 400)}`
        ],
        recordedAt: new Date().toISOString(),
        taskId: task.id,
        inputsDigest: digest
      };
      this._runStateRepo.appendVerdict(input.runsDir, state, verdict);
      this.printVerdict(verdict);
      return { verdict };
    }

    const sandbox = attempt.value;
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
      recovery: retried(attempt.history),
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
    digest: string,
    precomputedTestTier?: CriterionVerdict[]
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
      healthReport,
      precomputedTestTier
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
    healthReport: string | undefined,
    precomputedTestTier?: CriterionVerdict[]
  ): Promise<VerificationOutcome> {
    try {
      return await this._verification.verify({
        worktreePath,
        runsDir: input.runsDir,
        runId: input.runId,
        task,
        healthReport,
        precomputedTestTier,
        progress: { set: ctx => this._heartbeat.setContext(ctx) }
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
        `  [${this._gateMode}] ${verdict.gate} gate: ${verdict.outcome}` +
          (verdict.wouldEscalate ? ' (would escalate)' : '')
      )
    );
    for (const reason of verdict.reasons) {
      console.log(chalk.gray(`    - ${reason}`));
    }
  }
}

/**
 * The recovery history worth persisting on a step, or `undefined` when the
 * step succeeded first try.
 *
 * A history on every step would make "this step was flaky" invisible — the
 * signal is the presence of the record, so a clean run must not carry one.
 */
const retried = (history: RecoveryHistory): RecoveryHistory | undefined =>
  history.attempts.some(
    entry => entry.action !== 'attempt' || entry.outcome !== 'succeeded'
  )
    ? history
    : undefined;
