#!/usr/bin/env node
import 'reflect-metadata';
import { Container } from 'inversify';
import { readFileSync } from 'fs';
import path from 'path';
import chalk from 'chalk';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import os from 'os';
import { resolveDaemonCliEntry } from './utils/daemon-cli-entry';
import { RunHandler, IRunHandler } from './handlers/run.handler';
import { WorkflowHandler, IWorkflowHandler } from './handlers/workflow.handler';
import {
  AgentRunnerRepository,
  IAgentRunnerRepository
} from './repositories/agent-runner.repository';
import { AnthropicRepository } from './repositories/anthropic.repository';
import {
  ContractRepository,
  IContractRepository
} from './repositories/contract.repository';
import {
  EvidenceRepository,
  IEvidenceRepository
} from './repositories/evidence.repository';
import { GitRepository, IGitRepository } from './repositories/git.repository';
import {
  ShellCommandRepository,
  IShellCommandRepository
} from './repositories/shell-command.repository';
import {
  QueueRepository,
  IQueueRepository
} from './repositories/queue.repository';
import {
  ChronicleArtifactRepository,
  IChronicleArtifactRepository
} from './repositories/chronicle-artifact.repository';
import {
  CiStatusRepository,
  ICiStatusRepository
} from './repositories/ci-status.repository';
import { CursorCliRepository } from './repositories/cursor-cli.repository';
import { IModelRepository } from './repositories/model.repository';
import {
  InferenceRepository,
  IInferenceRepository
} from './repositories/inference.repository';
import { OpenAiRepository } from './repositories/openai.repository';
import { PrdRepository, IPrdRepository } from './repositories/prd.repository';
import {
  PullRequestRepository,
  IPullRequestRepository
} from './repositories/pull-request.repository';
import {
  RunQueueRepository,
  IRunQueueRepository
} from './repositories/run-queue.repository';
import {
  RunStateRepository,
  IRunStateRepository
} from './repositories/run-state.repository';
import {
  RunLockRepository,
  IRunLockRepository
} from './repositories/run-lock.repository';
import {
  SpecDocRepository,
  ISpecDocRepository
} from './repositories/spec-doc.repository';
import {
  SpecFileRepository,
  ISpecFileRepository
} from './repositories/spec-file.repository';
import {
  SurfaceMapRepository,
  ISurfaceMapRepository
} from './repositories/surface-map.repository';
import {
  ReviewChecklistRepository,
  IReviewChecklistRepository
} from './repositories/review-checklist.repository';
import {
  AggregatorService,
  IAggregatorService
} from './services/aggregator.service';
import {
  DecomposeService,
  IDecomposeService
} from './services/decompose.service';
import {
  EnvelopeGateService,
  IEnvelopeGateService
} from './services/envelope-gate.service';
import {
  ReviewerGateService,
  IReviewerGateService
} from './services/reviewer-gate.service';
import {
  ReviewerPublishService,
  IReviewerPublishService
} from './services/reviewer-publish.service';
import { ExecutorService, IExecutorService } from './services/executor.service';
import {
  SandboxDeployService,
  ISandboxDeployService
} from './services/sandbox-deploy.service';
import {
  VerificationService,
  IVerificationService
} from './services/verification.service';
import {
  SpecSynthesisService,
  ISpecSynthesisService
} from './services/spec-synthesis.service';
import { CiGateService, ICiGateService } from './services/ci-gate.service';
import { DigestService, IDigestService } from './services/digest.service';
import { RetroService, IRetroService } from './services/retro.service';
import {
  ChronicleCommitService,
  IChronicleCommitService
} from './services/chronicle-commit.service';
import {
  GatePolicyQueryService,
  IGatePolicyQueryService
} from './services/gate-policy-query.service';
import {
  PrLifecycleService,
  IPrLifecycleService
} from './services/pr-lifecycle.service';
import {
  EscalationService,
  IEscalationService
} from './services/escalation.service';
import {
  GateRemediationService,
  IGateRemediationService
} from './services/gate-remediation.service';
import {
  RetryExecutorService,
  IRetryExecutorService
} from './services/retry-executor.service';
import {
  DeployRecordRepository,
  IDeployRecordRepository
} from './repositories/deploy-record.repository';
import {
  DeployObservationRepository,
  IDeployObservationRepository
} from './repositories/deploy-observation.repository';
import {
  CloseoutAggregateService,
  ICloseoutAggregateService
} from './services/closeout-aggregate.service';
import { CloseoutService, ICloseoutService } from './services/closeout.service';
import {
  HeartbeatService,
  IHeartbeatService
} from './services/heartbeat.service';
import {
  HeartbeatWatchService,
  IHeartbeatWatchService
} from './services/heartbeat-watch.service';
import {
  ProcessDetachRepository,
  IProcessDetachRepository
} from './repositories/process-detach.repository';
import {
  IssueRepository,
  IIssueRepository
} from './repositories/issue.repository';
import {
  SuperviseExitRepository,
  ISuperviseExitRepository
} from './repositories/supervise-exit.repository';
import {
  WakeInboxRepository,
  IWakeInboxRepository
} from './repositories/wake-inbox.repository';
import {
  SuperviseService,
  ISuperviseService
} from './services/supervise.service';
import { DaemonHandler, IDaemonHandler } from './handlers/daemon.handler';
import {
  LegacyWakeInboxRepository,
  ILegacyWakeInboxRepository
} from './repositories/legacy-wake-inbox.repository';
import {
  LegacyWakeMigrateService,
  ILegacyWakeMigrateService
} from './services/legacy-wake-migrate.service';
import {
  DaemonConfigRepository,
  IDaemonConfigRepository
} from './repositories/daemon-config.repository';
import {
  DaemonProcessRepository,
  IDaemonProcessRepository
} from './repositories/daemon-process.repository';
import {
  LaunchdRepository,
  ILaunchdRepository
} from './repositories/launchd.repository';
import {
  ContinuityService,
  IContinuityService
} from './services/continuity.service';
import {
  StaleAgentService,
  IStaleAgentService
} from './services/stale-agent.service';
import {
  DaemonLifecycleService,
  IDaemonLifecycleService
} from './services/daemon-lifecycle.service';
import {
  DaemonStatusService,
  IDaemonStatusService
} from './services/daemon-status.service';
import {
  DaemonStoreRepository,
  IDaemonStoreRepository
} from './repositories/daemon-store.repository';
import {
  KnownWatchTargetRepository,
  IKnownWatchTargetRepository
} from './repositories/known-watch-target.repository';
import {
  IWatchRegistryService,
  WatchRegistryService
} from './services/watch-registry.service';
import {
  IPollSchedulerService,
  PollSchedulerService
} from './services/poll-scheduler.service';
import {
  IWatchSourceAdapter,
  IWatchSourceAdapterRegistry,
  WatchSourceAdapterRegistry
} from './services/watch-source-adapter';
import {
  GitHubWatchSourceRepository,
  IGitHubWatchSourceRepository
} from './repositories/github-watch-source.repository';
import { PrReviewWatchSourceAdapter } from './services/pr-review-watch-source.adapter';
import { PrChecksWatchSourceAdapter } from './services/pr-checks-watch-source.adapter';
import { IssueStateWatchSourceAdapter } from './services/issue-state-watch-source.adapter';
import {
  IWakeActionRegistry,
  WakeActionRegistry
} from './services/wake-action';
import { NotifyWakeAction } from './services/notify-wake.action';
import { EngineResumeWakeAction } from './services/engine-resume-wake.action';
import type { IWakeAction } from './services/wake-action';
import {
  IWakeConsumptionService,
  WakeConsumptionService
} from './services/wake-consumption.service';
import { WORKFLOW_TOKENS } from './tokens';
import { WorkflowError } from './types';
import { resolveInferenceBackend } from './utils/backend-select';
import { runExitCode } from './utils/run-exit';
import { lintSpec } from './utils/spec-lint';

const container = new Container();
const modelBinding = container.bind<IModelRepository>(
  WORKFLOW_TOKENS.ModelRepository
);
const backend = resolveInferenceBackend(process.env);
if (backend === 'anthropic') {
  modelBinding.to(AnthropicRepository);
} else if (backend === 'openai') {
  modelBinding.to(OpenAiRepository);
} else {
  modelBinding.to(CursorCliRepository);
}
container
  .bind<IInferenceRepository>(WORKFLOW_TOKENS.InferenceRepository)
  .to(InferenceRepository);
container.bind<IPrdRepository>(WORKFLOW_TOKENS.PrdRepository).to(PrdRepository);
container
  .bind<ISpecFileRepository>(WORKFLOW_TOKENS.SpecFileRepository)
  .to(SpecFileRepository);
container
  .bind<IDecomposeService>(WORKFLOW_TOKENS.DecomposeService)
  .to(DecomposeService);
container
  .bind<ISpecSynthesisService>(WORKFLOW_TOKENS.SpecSynthesisService)
  .to(SpecSynthesisService);
container
  .bind<IWorkflowHandler>(WORKFLOW_TOKENS.WorkflowHandler)
  .to(WorkflowHandler);
container
  .bind<ISpecDocRepository>(WORKFLOW_TOKENS.SpecDocRepository)
  .to(SpecDocRepository);
container.bind<IGitRepository>(WORKFLOW_TOKENS.GitRepository).to(GitRepository);
container
  .bind<IAgentRunnerRepository>(WORKFLOW_TOKENS.AgentRunnerRepository)
  .to(AgentRunnerRepository);
container
  .bind<IRunLockRepository>(WORKFLOW_TOKENS.RunLockRepository)
  .to(RunLockRepository);
container
  .bind<IRunStateRepository>(WORKFLOW_TOKENS.RunStateRepository)
  .to(RunStateRepository);
container
  .bind<ISurfaceMapRepository>(WORKFLOW_TOKENS.SurfaceMapRepository)
  .to(SurfaceMapRepository);
container
  .bind<IReviewChecklistRepository>(WORKFLOW_TOKENS.ReviewChecklistRepository)
  .to(ReviewChecklistRepository);
container
  .bind<IExecutorService>(WORKFLOW_TOKENS.ExecutorService)
  .to(ExecutorService);
container
  .bind<IEnvelopeGateService>(WORKFLOW_TOKENS.EnvelopeGateService)
  .to(EnvelopeGateService);
container
  .bind<IContractRepository>(WORKFLOW_TOKENS.ContractRepository)
  .to(ContractRepository);
container
  .bind<IShellCommandRepository>(WORKFLOW_TOKENS.ShellCommandRepository)
  .to(ShellCommandRepository);
container
  .bind<IEvidenceRepository>(WORKFLOW_TOKENS.EvidenceRepository)
  .to(EvidenceRepository);
container
  .bind<ISandboxDeployService>(WORKFLOW_TOKENS.SandboxDeployService)
  .to(SandboxDeployService);
container
  .bind<IVerificationService>(WORKFLOW_TOKENS.VerificationService)
  .to(VerificationService);
container
  .bind<IReviewerGateService>(WORKFLOW_TOKENS.ReviewerGateService)
  .to(ReviewerGateService);
container
  .bind<IReviewerPublishService>(WORKFLOW_TOKENS.ReviewerPublishService)
  .to(ReviewerPublishService);
container
  .bind<IAggregatorService>(WORKFLOW_TOKENS.AggregatorService)
  .to(AggregatorService);
container
  .bind<IQueueRepository>(WORKFLOW_TOKENS.QueueRepository)
  .to(QueueRepository);
container
  .bind<IChronicleArtifactRepository>(
    WORKFLOW_TOKENS.ChronicleArtifactRepository
  )
  .to(ChronicleArtifactRepository);
container
  .bind<ICiStatusRepository>(WORKFLOW_TOKENS.CiStatusRepository)
  .to(CiStatusRepository);
container.bind<ICiGateService>(WORKFLOW_TOKENS.CiGateService).to(CiGateService);
container.bind<IDigestService>(WORKFLOW_TOKENS.DigestService).to(DigestService);
container.bind<IRetroService>(WORKFLOW_TOKENS.RetroService).to(RetroService);
container
  .bind<IChronicleCommitService>(WORKFLOW_TOKENS.ChronicleCommitService)
  .to(ChronicleCommitService);
container
  .bind<IGatePolicyQueryService>(WORKFLOW_TOKENS.GatePolicyQueryService)
  .to(GatePolicyQueryService);
container
  .bind<IPullRequestRepository>(WORKFLOW_TOKENS.PullRequestRepository)
  .to(PullRequestRepository);
container
  .bind<IIssueRepository>(WORKFLOW_TOKENS.IssueRepository)
  .to(IssueRepository);
container
  .bind<IWakeInboxRepository>(WORKFLOW_TOKENS.WakeInboxRepository)
  .to(WakeInboxRepository);
container
  .bind<IPrLifecycleService>(WORKFLOW_TOKENS.PrLifecycleService)
  .to(PrLifecycleService);
container
  .bind<IEscalationService>(WORKFLOW_TOKENS.EscalationService)
  .to(EscalationService);
container
  .bind<IGateRemediationService>(WORKFLOW_TOKENS.GateRemediationService)
  .to(GateRemediationService);
container
  .bind<IRetryExecutorService>(WORKFLOW_TOKENS.RetryExecutorService)
  .to(RetryExecutorService);
container
  .bind<IDeployRecordRepository>(WORKFLOW_TOKENS.DeployRecordRepository)
  .to(DeployRecordRepository);
container
  .bind<IDeployObservationRepository>(
    WORKFLOW_TOKENS.DeployObservationRepository
  )
  .to(DeployObservationRepository);
container
  .bind<ICloseoutAggregateService>(WORKFLOW_TOKENS.CloseoutAggregateService)
  .to(CloseoutAggregateService);
container
  .bind<ICloseoutService>(WORKFLOW_TOKENS.CloseoutService)
  .to(CloseoutService);
container
  .bind<IHeartbeatService>(WORKFLOW_TOKENS.HeartbeatService)
  .to(HeartbeatService);
container
  .bind<IHeartbeatWatchService>(WORKFLOW_TOKENS.HeartbeatWatchService)
  .to(HeartbeatWatchService);
container
  .bind<IProcessDetachRepository>(WORKFLOW_TOKENS.ProcessDetachRepository)
  .to(ProcessDetachRepository);
container
  .bind<ISuperviseExitRepository>(WORKFLOW_TOKENS.SuperviseExitRepository)
  .to(SuperviseExitRepository);
container
  .bind<IRunQueueRepository>(WORKFLOW_TOKENS.RunQueueRepository)
  .to(RunQueueRepository);
container.bind<IRunHandler>(WORKFLOW_TOKENS.RunHandler).to(RunHandler);
container
  .bind<ISuperviseService>(WORKFLOW_TOKENS.SuperviseService)
  .to(SuperviseService);
container
  .bind<IDaemonConfigRepository>(WORKFLOW_TOKENS.DaemonConfigRepository)
  .to(DaemonConfigRepository);
container
  .bind<IDaemonProcessRepository>(WORKFLOW_TOKENS.DaemonProcessRepository)
  .to(DaemonProcessRepository);
container
  .bind<ILaunchdRepository>(WORKFLOW_TOKENS.LaunchdRepository)
  .to(LaunchdRepository);
container
  .bind<IDaemonLifecycleService>(WORKFLOW_TOKENS.DaemonLifecycleService)
  .to(DaemonLifecycleService);
container
  .bind<IDaemonStoreRepository>(WORKFLOW_TOKENS.DaemonStoreRepository)
  .to(DaemonStoreRepository);
container
  .bind<IWatchRegistryService>(WORKFLOW_TOKENS.WatchRegistryService)
  .to(WatchRegistryService);
container
  .bind<IWatchSourceAdapterRegistry>(WORKFLOW_TOKENS.WatchSourceAdapterRegistry)
  .to(WatchSourceAdapterRegistry)
  .inSingletonScope();
container
  .bind<IGitHubWatchSourceRepository>(
    WORKFLOW_TOKENS.GitHubWatchSourceRepository
  )
  .to(GitHubWatchSourceRepository);
container
  .bind<IWatchSourceAdapter>(WORKFLOW_TOKENS.PrReviewWatchSourceAdapter)
  .to(PrReviewWatchSourceAdapter);
container
  .bind<IWatchSourceAdapter>(WORKFLOW_TOKENS.PrChecksWatchSourceAdapter)
  .to(PrChecksWatchSourceAdapter);
container
  .bind<IWatchSourceAdapter>(WORKFLOW_TOKENS.IssueStateWatchSourceAdapter)
  .to(IssueStateWatchSourceAdapter);
container
  .bind<IPollSchedulerService>(WORKFLOW_TOKENS.PollSchedulerService)
  .to(PollSchedulerService)
  .inSingletonScope();
container
  .bind<IWakeActionRegistry>(WORKFLOW_TOKENS.WakeActionRegistry)
  .to(WakeActionRegistry)
  .inSingletonScope();
container
  .bind<EngineResumeWakeAction>(WORKFLOW_TOKENS.EngineResumeWakeAction)
  .to(EngineResumeWakeAction);
container
  .bind<IWakeConsumptionService>(WORKFLOW_TOKENS.WakeConsumptionService)
  .to(WakeConsumptionService)
  .inSingletonScope();
container
  .bind<IKnownWatchTargetRepository>(WORKFLOW_TOKENS.KnownWatchTargetRepository)
  .to(KnownWatchTargetRepository);
container
  .bind<IDaemonStatusService>(WORKFLOW_TOKENS.DaemonStatusService)
  .to(DaemonStatusService);
container
  .bind<ILegacyWakeInboxRepository>(WORKFLOW_TOKENS.LegacyWakeInboxRepository)
  .to(LegacyWakeInboxRepository);
container
  .bind<ILegacyWakeMigrateService>(WORKFLOW_TOKENS.LegacyWakeMigrateService)
  .to(LegacyWakeMigrateService);
container
  .bind<IStaleAgentService>(WORKFLOW_TOKENS.StaleAgentService)
  .to(StaleAgentService)
  .inSingletonScope();
container
  .bind<IContinuityService>(WORKFLOW_TOKENS.ContinuityService)
  .to(ContinuityService)
  .inSingletonScope();

{
  // pr-review / pr-checks (Phase 1) + issue-state (remote-resume slice).
  // Remaining kinds stay unregistered until their adapters land.
  const adapters = container.get<IWatchSourceAdapterRegistry>(
    WORKFLOW_TOKENS.WatchSourceAdapterRegistry
  );
  adapters.register(
    'pr-review',
    container.get<IWatchSourceAdapter>(
      WORKFLOW_TOKENS.PrReviewWatchSourceAdapter
    )
  );
  adapters.register(
    'pr-checks',
    container.get<IWatchSourceAdapter>(
      WORKFLOW_TOKENS.PrChecksWatchSourceAdapter
    )
  );
  adapters.register(
    'issue-state',
    container.get<IWatchSourceAdapter>(
      WORKFLOW_TOKENS.IssueStateWatchSourceAdapter
    )
  );

  // Notify mirrors plus headless EngineResume (blocker-close / PR merge).
  const actions = container.get<IWakeActionRegistry>(
    WORKFLOW_TOKENS.WakeActionRegistry
  );
  actions.register(new NotifyWakeAction());
  actions.register(
    container.get<IWakeAction>(WORKFLOW_TOKENS.EngineResumeWakeAction)
  );
}

container.bind<IDaemonHandler>(WORKFLOW_TOKENS.DaemonHandler).to(DaemonHandler);

yargs(hideBin(process.argv))
  .command(
    'prd-lint',
    'Validate a PRD parses cleanly against TEMPLATE.md, with no LLM call and no --repo required',
    y =>
      y
        .option('prd', {
          type: 'string',
          demandOption: true,
          describe: 'PRD ID, e.g. PRD-0011'
        })
        .option('docs-dir', {
          type: 'string',
          default: path.join('..', 'rosetta_docs', 'product'),
          describe: 'Directory containing PRD markdown files'
        }),
    async argv => {
      const prdRepo = container.get<IPrdRepository>(
        WORKFLOW_TOKENS.PrdRepository
      );
      try {
        const prd = await prdRepo.getPrd(argv.prd, argv['docs-dir']);
        console.log(chalk.green(`✓ ${prd.id} — ${prd.title}`));
        console.log(chalk.gray(`  goals: ${prd.goals.length}`));
        console.log(chalk.gray(`  non-goals: ${prd.nonGoals.length}`));
        console.log(
          chalk.gray(`  acceptance criteria: ${prd.acceptanceCriteria.length}`)
        );
        console.log(
          chalk.gray(`  rollout phases: ${prd.rolloutPhases.length}`)
        );
      } catch (err) {
        if (err instanceof WorkflowError) {
          console.error(chalk.red(`\n✗ ${err.code}: ${err.message}`));
          for (const detail of err.details) {
            console.error(chalk.red(`  - ${detail}`));
          }
        } else {
          console.error(chalk.red(`\n✗ ${err}`));
        }
        process.exit(1);
      }
    }
  )
  .command(
    'spec-lint',
    'Validate an ADR-0008 spec file: front-matter parse, envelope schema, and checkbox integrity — no LLM call, no --repo required (hook/CI safe)',
    y =>
      y.option('spec', {
        type: 'string',
        demandOption: true,
        describe: 'Path to the implementation spec Markdown file'
      }),
    argv => {
      let markdown: string;
      try {
        markdown = readFileSync(argv.spec, 'utf-8');
      } catch {
        console.error(
          chalk.red(`\n✗ SPEC_MALFORMED: spec file not found: ${argv.spec}`)
        );
        process.exit(1);
        return;
      }
      const report = lintSpec(markdown);
      if (report.ok) {
        console.log(
          chalk.green(`✓ ${report.specId} — ${report.status} — spec-lint clean`)
        );
        console.log(
          chalk.gray(
            `  tasks: ${report.taskCount}, acceptance criteria: ${report.criterionCount}`
          )
        );
        return;
      }
      console.error(
        chalk.red(`\n✗ spec-lint found ${report.findings.length} issue(s):`)
      );
      for (const finding of report.findings) {
        console.error(chalk.red(`  - ${finding.code}: ${finding.message}`));
      }
      process.exit(1);
    }
  )
  .command(
    'decompose',
    'Decompose a PRD into a Draft implementation spec (stops at the human gate)',
    y =>
      y
        .option('prd', {
          type: 'string',
          demandOption: true,
          describe: 'PRD ID, e.g. PRD-0011'
        })
        .option('repo', {
          type: 'string',
          demandOption: true,
          describe: 'Path to the target repo the spec is written into'
        })
        .option('docs-dir', {
          type: 'string',
          default: path.join('..', 'rosetta_docs', 'product'),
          describe: 'Directory containing PRD markdown files'
        })
        .option('phase', {
          type: 'number',
          default: 1,
          describe: 'PRD rollout phase to specify'
        })
        .option('budget-k', {
          type: 'number',
          default: 200,
          describe: 'Token budget in thousands (recorded in the envelope)'
        }),
    async argv => {
      const handler = container.get<IWorkflowHandler>(
        WORKFLOW_TOKENS.WorkflowHandler
      );
      try {
        await handler.runDecompose({
          prdId: argv.prd,
          repoPath: argv.repo,
          docsDir: argv['docs-dir'],
          phase: argv.phase,
          budgetK: argv['budget-k']
        });
      } catch (err) {
        if (err instanceof WorkflowError) {
          console.error(chalk.red(`\n✗ ${err.code}: ${err.message}`));
          for (const detail of err.details) {
            console.error(chalk.red(`  - ${detail}`));
          }
        } else {
          console.error(chalk.red(`\n✗ ${err}`));
        }
        process.exit(1);
      }
    }
  )
  .command(
    'run',
    'Execute ready tasks from an Approved spec (use --supervise to auto-resume waves; --detach to background)',
    y =>
      y
        .option('spec', {
          type: 'string',
          demandOption: true,
          describe: 'Path to the Approved implementation spec'
        })
        .option('repo', {
          type: 'string',
          demandOption: true,
          describe: 'Path to the target repo the task is implemented in'
        })
        .option('run-id', {
          type: 'string',
          describe:
            'Stable run identifier (deterministic branch names derive from it); defaults to <spec-id>-<date>'
        })
        .option('runs-dir', {
          type: 'string',
          default: path.join(os.homedir(), '.rosetta', 'sdlc-runs'),
          describe: 'Directory holding run state and task worktrees'
        })
        .option('chronicle-repo', {
          type: 'string',
          describe:
            'Personal Chronicle ledger repo — enables the T-07 queue digest and T-08 artifact commits'
        })
        .option('max-parallel', {
          type: 'number',
          default: 3,
          describe:
            'Upper bound on concurrently running implementation agents (P3 T-01)'
        })
        .option('shadow', {
          type: 'boolean',
          default: false,
          describe:
            'Calibration mode: record gate verdicts but never merge (P3 T-04)'
        })
        .option('heartbeat', {
          type: 'number',
          default: 30,
          describe:
            'Emit structured progress lines every N seconds (0 disables) — #39'
        })
        .option('supervise', {
          type: 'boolean',
          default: false,
          describe:
            'Auto-resume dependency waves + live heartbeat monitor (recommended; likely future default)'
        })
        .option('detach', {
          type: 'boolean',
          default: false,
          describe:
            'Spawn a detached supervise child and exit (survives agent shell teardown — #38)'
        })
        .option('max-waves', {
          type: 'number',
          default: 20,
          describe: 'Supervise: max wave iterations before giving up'
        })
        .option('monitor', {
          type: 'string',
          describe:
            'Supervise: path for the live heartbeat monitor log (default: <runsDir>/<runId>/monitor.log)'
        })
        .option('operator', {
          type: 'string',
          describe:
            'GitHub login assigned on needs-human escalation issues (also SDLC_OPERATOR env)'
        }),
    async argv => {
      const supervise = container.get<ISuperviseService>(
        WORKFLOW_TOKENS.SuperviseService
      );
      const runId =
        argv['run-id'] ??
        `${path
          .basename(argv.spec)
          .replace(/\.md$/, '')}-${new Date().toISOString().slice(0, 10)}`;
      const operatorFlag =
        typeof argv.operator === 'string' ? argv.operator.trim() : '';
      const operatorEnv =
        typeof process.env.SDLC_OPERATOR === 'string'
          ? process.env.SDLC_OPERATOR.trim()
          : '';
      const operator =
        operatorFlag.length > 0
          ? operatorFlag
          : operatorEnv.length > 0
            ? operatorEnv
            : undefined;
      try {
        const result = await supervise.run({
          specPath: argv.spec,
          repoPath: argv.repo,
          runId,
          runsDir: argv['runs-dir'],
          chronicleRepo: argv['chronicle-repo'],
          maxParallel: argv['max-parallel'],
          shadow: argv.shadow,
          heartbeatSeconds: argv.heartbeat,
          supervise: argv.supervise === true || argv.detach === true,
          detach: argv.detach === true,
          maxWaves: argv['max-waves'],
          monitorPath: argv.monitor,
          operator,
          launchArgv: process.argv
        });
        if (result.kind === 'detached') {
          process.exit(0);
        }
        // Refused intake, blocked wave, or task failure all exit non-zero
        // (#37 / fail-loud T-01) — mapping lives in utils for testability.
        if (runExitCode(result) !== 0) {
          process.exit(1);
        }
      } catch (err) {
        if (err instanceof WorkflowError) {
          console.error(chalk.red(`\n✗ ${err.code}: ${err.message}`));
          for (const detail of err.details) {
            console.error(chalk.red(`  - ${detail}`));
          }
        } else {
          console.error(chalk.red(`\n✗ ${err}`));
        }
        process.exit(1);
      }
    }
  )
  .command(
    'queue-run',
    'Write a durable launch record for a spec, launched detached when the current supervised run completes and the spec is Approved (T-02)',
    y =>
      y
        .option('spec', {
          type: 'string',
          demandOption: true,
          describe: 'Path to the spec to launch when its turn comes'
        })
        .option('repo', {
          type: 'string',
          demandOption: true,
          describe: 'Path to the target repo the queued run will execute in'
        })
        .option('run-id', {
          type: 'string',
          describe: 'Stable run identifier for the queued launch'
        })
        .option('runs-dir', {
          type: 'string',
          default: path.join(os.homedir(), '.rosetta', 'sdlc-runs'),
          describe: 'Directory holding run state and the launch queue'
        })
        .option('chronicle-repo', {
          type: 'string',
          describe: 'Personal Chronicle ledger repo for the queued run'
        })
        .option('max-parallel', {
          type: 'number',
          default: 3,
          describe: 'Concurrent implementation agents for the queued run'
        })
        .option('heartbeat', {
          type: 'number',
          default: 30,
          describe: 'Heartbeat interval (seconds) for the queued run'
        })
        .option('max-waves', {
          type: 'number',
          default: 20,
          describe: 'Max wave iterations for the queued run'
        })
        .option('monitor', {
          type: 'string',
          describe: 'Monitor log path override for the queued run'
        })
        .option('operator', {
          type: 'string',
          describe:
            'GitHub login assigned on needs-human escalation issues for the queued run'
        }),
    argv => {
      const handler = container.get<IRunHandler>(WORKFLOW_TOKENS.RunHandler);
      try {
        handler.queueRun({
          specPath: argv.spec,
          repoPath: argv.repo,
          runId: argv['run-id'],
          runsDir: argv['runs-dir'],
          chronicleRepo: argv['chronicle-repo'],
          maxParallel: argv['max-parallel'],
          heartbeatSeconds: argv.heartbeat,
          maxWaves: argv['max-waves'],
          monitorPath: argv.monitor,
          operator: argv.operator
        });
      } catch (err) {
        if (err instanceof WorkflowError) {
          console.error(chalk.red(`\n✗ ${err.code}: ${err.message}`));
          for (const detail of err.details) {
            console.error(chalk.red(`  - ${detail}`));
          }
        } else {
          console.error(chalk.red(`\n✗ ${err}`));
        }
        process.exit(1);
      }
    }
  )
  .command(
    'record-merge',
    'Record a human-approved merge in the run Chronicle artifact (T-08)',
    y =>
      y
        .option('run-id', {
          type: 'string',
          demandOption: true,
          describe: 'Run identifier the merge belongs to'
        })
        .option('sha', {
          type: 'string',
          demandOption: true,
          describe: 'Merged commit SHA on the default branch'
        })
        .option('chronicle-repo', {
          type: 'string',
          demandOption: true,
          describe: 'Personal Chronicle ledger repo'
        })
        .option('task', {
          type: 'string',
          describe:
            'Task ID the merge belongs to — marks it merged, unblocking dependents (P3 T-01)'
        })
        .option('repo', {
          type: 'string',
          describe:
            'Target repo checkout — with --task, schedules fire-and-forget cleanup of the task worktree'
        })
        .option('runs-dir', {
          type: 'string',
          default: path.join(os.homedir(), '.rosetta', 'sdlc-runs'),
          describe: 'Directory holding run state'
        }),
    async argv => {
      const handler = container.get<IRunHandler>(WORKFLOW_TOKENS.RunHandler);
      try {
        await handler.recordMerge({
          chronicleRepo: argv['chronicle-repo'],
          runsDir: argv['runs-dir'],
          runId: argv['run-id'],
          mergedSha: argv.sha,
          repoPath: argv.repo,
          taskId: argv.task
        });
      } catch (err) {
        if (err instanceof WorkflowError) {
          console.error(chalk.red(`\n✗ ${err.code}: ${err.message}`));
          for (const detail of err.details) {
            console.error(chalk.red(`  - ${detail}`));
          }
        } else {
          console.error(chalk.red(`\n✗ ${err}`));
        }
        process.exit(1);
      }
    }
  )
  .command(
    'check-veto',
    'Check the phase digest queue item for a [veto] tag; revert the phase merges and redeploy the sandbox when present (P3 T-05)',
    y =>
      y
        .option('run-id', {
          type: 'string',
          demandOption: true,
          describe: 'Run identifier whose digest item to check'
        })
        .option('repo', {
          type: 'string',
          demandOption: true,
          describe: 'Path to the target repo the phase merged into'
        })
        .option('chronicle-repo', {
          type: 'string',
          demandOption: true,
          describe: 'Personal Chronicle ledger repo holding the queue'
        })
        .option('runs-dir', {
          type: 'string',
          default: path.join(os.homedir(), '.rosetta', 'sdlc-runs'),
          describe: 'Directory holding run state'
        }),
    async argv => {
      const handler = container.get<IRunHandler>(WORKFLOW_TOKENS.RunHandler);
      try {
        await handler.checkVeto({
          runsDir: argv['runs-dir'],
          runId: argv['run-id'],
          repoPath: argv.repo,
          chronicleRepo: argv['chronicle-repo']
        });
      } catch (err) {
        if (err instanceof WorkflowError) {
          console.error(chalk.red(`\n✗ ${err.code}: ${err.message}`));
          for (const detail of err.details) {
            console.error(chalk.red(`  - ${detail}`));
          }
        } else {
          console.error(chalk.red(`\n✗ ${err}`));
        }
        process.exit(1);
      }
    }
  )
  .command(
    'closeout',
    "Generate or refresh a spec's closeout PR from a run's recorded verdicts — checkboxes and status: Done are derived, never authored (SPEC-PRD-0023-P1)",
    y =>
      y
        .option('run-id', {
          type: 'string',
          demandOption: true,
          describe: 'Run whose recorded verdicts the closeout derives from'
        })
        .option('spec', {
          type: 'string',
          demandOption: true,
          describe: 'Path to the spec to close out (inside --repo)'
        })
        .option('repo', {
          type: 'string',
          demandOption: true,
          describe: 'Path to the repo owning the spec'
        })
        .option('runs-dir', {
          type: 'string',
          default: path.join(os.homedir(), '.rosetta', 'sdlc-runs'),
          describe: 'Directory holding run state'
        }),
    async argv => {
      const handler = container.get<IRunHandler>(WORKFLOW_TOKENS.RunHandler);
      try {
        await handler.closeout({
          runsDir: argv['runs-dir'],
          runId: argv['run-id'],
          repoPath: argv.repo,
          specPath: argv.spec
        });
      } catch (err) {
        if (err instanceof WorkflowError) {
          console.error(chalk.red(`\n✗ ${err.code}: ${err.message}`));
          for (const detail of err.details) {
            console.error(chalk.red(`  - ${detail}`));
          }
        } else {
          console.error(chalk.red(`\n✗ ${err}`));
        }
        process.exit(1);
      }
    }
  )
  .command(
    'daemon',
    'Per-workspace SDLC event daemon — run, status, watch, or install/uninstall the launchd agent (SPEC-PRD-0020-P1)',
    y =>
      y
        .command(
          '$0',
          'Run the daemon in the foreground for --workspace (KeepAlive relaunches via launchd)',
          y2 =>
            y2.option('workspace', {
              type: 'string',
              describe: 'Absolute or relative path to the workspace root'
            }),
          async argv => {
            const handler = container.get<IDaemonHandler>(
              WORKFLOW_TOKENS.DaemonHandler
            );
            try {
              await handler.run({
                workspaceRoot: argv.workspace
              });
            } catch (err) {
              if (err instanceof WorkflowError) {
                console.error(chalk.red(`\n✗ ${err.code}: ${err.message}`));
                for (const detail of err.details) {
                  console.error(chalk.red(`  - ${detail}`));
                }
              } else {
                console.error(chalk.red(`\n✗ ${err}`));
              }
              process.exit(1);
            }
          }
        )
        .command(
          'status',
          'List active watches, wakes, and unwatched known PRs/runs (SPEC-PRD-0020-P1 T-07)',
          y2 =>
            y2
              .option('workspace', {
                type: 'string',
                describe: 'Absolute or relative path to the workspace root'
              })
              .option('json', {
                type: 'boolean',
                default: false,
                describe: 'Emit a machine-readable JSON status report'
              }),
          argv => {
            const handler = container.get<IDaemonHandler>(
              WORKFLOW_TOKENS.DaemonHandler
            );
            try {
              handler.status({
                workspaceRoot: argv.workspace,
                json: argv.json === true
              });
            } catch (err) {
              if (err instanceof WorkflowError) {
                console.error(chalk.red(`\n✗ ${err.code}: ${err.message}`));
                for (const detail of err.details) {
                  console.error(chalk.red(`  - ${detail}`));
                }
              } else {
                console.error(chalk.red(`\n✗ ${err}`));
              }
              process.exit(1);
            }
          }
        )
        .command(
          'install',
          'Generate and load a KeepAlive launchd plist for --workspace',
          y2 =>
            y2
              .option('workspace', {
                type: 'string',
                describe: 'Absolute or relative path to the workspace root'
              })
              .option('plist-dir', {
                type: 'string',
                describe:
                  'Directory for the plist (default: ~/Library/LaunchAgents)'
              })
              // Name the positive flag `load` so yargs' built-in `--no-load`
              // negation works. Declaring `no-load` as its own option makes
              // strict mode reject `--no-load` as "Unknown argument: load".
              .option('load', {
                type: 'boolean',
                default: true,
                describe:
                  'Call launchctl bootstrap/enable (use --no-load to write the plist only)'
              }),
          argv => {
            const handler = container.get<IDaemonHandler>(
              WORKFLOW_TOKENS.DaemonHandler
            );
            try {
              // Dev runners leave __filename on src/*.ts; launchd needs dist/.
              // --no-load may run before `bun run build`; loaded installs must
              // see dist/index.js so KeepAlive cannot point at a missing file.
              const load = argv.load !== false;
              handler.install({
                workspaceRoot: argv.workspace,
                plistDir: argv['plist-dir'],
                load,
                cliEntry: resolveDaemonCliEntry(__filename, {
                  requireDist: load
                }),
                program: process.execPath
              });
            } catch (err) {
              if (err instanceof WorkflowError) {
                console.error(chalk.red(`\n✗ ${err.code}: ${err.message}`));
                for (const detail of err.details) {
                  console.error(chalk.red(`  - ${detail}`));
                }
              } else {
                console.error(chalk.red(`\n✗ ${err}`));
              }
              process.exit(1);
            }
          }
        )
        .command(
          'uninstall',
          'Unload and remove the launchd plist for --workspace',
          y2 =>
            y2
              .option('workspace', {
                type: 'string',
                describe: 'Absolute or relative path to the workspace root'
              })
              .option('plist-dir', {
                type: 'string',
                describe:
                  'Directory holding the plist (default: ~/Library/LaunchAgents)'
              }),
          argv => {
            const handler = container.get<IDaemonHandler>(
              WORKFLOW_TOKENS.DaemonHandler
            );
            try {
              handler.uninstall({
                workspaceRoot: argv.workspace,
                plistDir: argv['plist-dir']
              });
            } catch (err) {
              if (err instanceof WorkflowError) {
                console.error(chalk.red(`\n✗ ${err.code}: ${err.message}`));
              } else {
                console.error(chalk.red(`\n✗ ${err}`));
              }
              process.exit(1);
            }
          }
        )
        .command(
          'watch [targets..]',
          'Register durable watch(es) for owner/repo#N targets and exit (SPEC-PRD-0020-P1 T-08)',
          y2 =>
            y2
              .option('workspace', {
                type: 'string',
                describe: 'Absolute or relative path to the workspace root'
              })
              .option('kind', {
                type: 'string',
                default: 'pr-review',
                choices: ['pr-review', 'pr-checks'],
                describe:
                  'Watch kind — only the owner/repo#N kinds are registrable here'
              })
              .option('poll-seconds', {
                type: 'number',
                describe:
                  'Poll cadence in seconds (default: workspace defaultPollSeconds)'
              })
              .option('created-by', {
                type: 'string',
                default: 'cli',
                describe: 'Registration attribution (skill id or operator)'
              })
              .option('json', {
                type: 'boolean',
                default: false,
                describe: 'Emit registered watch records as JSON'
              })
              .positional('targets', {
                type: 'string',
                array: true,
                describe: 'One or more owner/repo#N targets'
              }),
          argv => {
            const handler = container.get<IDaemonHandler>(
              WORKFLOW_TOKENS.DaemonHandler
            );
            const targets = Array.isArray(argv.targets)
              ? argv.targets.filter(
                  (value): value is string => typeof value === 'string'
                )
              : [];
            try {
              handler.watch({
                workspaceRoot: argv.workspace,
                kind: argv.kind,
                targets,
                pollSeconds: argv['poll-seconds'],
                createdBy: argv['created-by'],
                json: argv.json === true
              });
            } catch (err) {
              if (err instanceof WorkflowError) {
                console.error(chalk.red(`\n✗ ${err.code}: ${err.message}`));
                for (const detail of err.details) {
                  console.error(chalk.red(`  - ${detail}`));
                }
              } else {
                console.error(chalk.red(`\n✗ ${err}`));
              }
              process.exit(1);
            }
          }
        )
        .command(
          'migrate-wake',
          'Import ~/.rosetta/wake/pending into .sdlc/daemon/wake for daemon drain',
          y2 =>
            y2
              .option('workspace', {
                type: 'string',
                describe: 'Absolute or relative path to the workspace root'
              })
              .option('from', {
                type: 'string',
                describe:
                  'Legacy wake root (default: $ROSETTA_WAKE_DIR or ~/.rosetta/wake)'
              })
              .option('disposition', {
                type: 'string',
                default: 'auto',
                choices: ['auto', 'pending', 'consumed'],
                describe:
                  'auto: pr_approve→consumed, escalations→pending; pending|consumed force all'
              })
              .option('dry-run', {
                type: 'boolean',
                default: false,
                describe: 'Map and report without writing or archiving'
              })
              .option('json', {
                type: 'boolean',
                default: false,
                describe: 'Emit the migrate report as JSON'
              }),
          argv => {
            const handler = container.get<IDaemonHandler>(
              WORKFLOW_TOKENS.DaemonHandler
            );
            void handler
              .migrateWake({
                workspaceRoot: argv.workspace,
                from: argv.from,
                disposition: argv.disposition as
                  'auto' | 'pending' | 'consumed' | undefined,
                dryRun: argv['dry-run'] === true,
                json: argv.json === true
              })
              .catch(err => {
                if (err instanceof WorkflowError) {
                  console.error(chalk.red(`\n✗ ${err.code}: ${err.message}`));
                  for (const detail of err.details) {
                    console.error(chalk.red(`  - ${detail}`));
                  }
                } else {
                  console.error(chalk.red(`\n✗ ${err}`));
                }
                process.exit(1);
              });
          }
        )
        .demandCommand(0)
        .recommendCommands(),
    () => {
      // Parent handler unused — subcommands own dispatch.
    }
  )
  .command(
    'status',
    'Show a run: task results, cached step graph, verdicts, exceptions (T-09); or list the launch queue with --queue (T-02)',
    y =>
      y
        .option('run-id', {
          type: 'string',
          describe: 'Run identifier to inspect'
        })
        .option('runs-dir', {
          type: 'string',
          default: path.join(os.homedir(), '.rosetta', 'sdlc-runs'),
          describe: 'Directory holding run state'
        })
        .option('queue', {
          type: 'boolean',
          default: false,
          describe: 'List queued launch records instead of a run (T-02)'
        }),
    argv => {
      const handler = container.get<IRunHandler>(WORKFLOW_TOKENS.RunHandler);
      try {
        if (argv.queue === true) {
          handler.listQueue({ runsDir: argv['runs-dir'] });
          return;
        }
        if (argv['run-id'] === undefined) {
          console.error(
            chalk.red(
              '\n✗ status requires --run-id (or --queue to list the launch queue)'
            )
          );
          process.exit(1);
          return;
        }
        handler.showStatus({
          runsDir: argv['runs-dir'],
          runId: argv['run-id']
        });
      } catch (err) {
        if (err instanceof WorkflowError) {
          console.error(chalk.red(`\n✗ ${err.code}: ${err.message}`));
        } else {
          console.error(chalk.red(`\n✗ ${err}`));
        }
        process.exit(1);
      }
    }
  )
  .demandCommand(1, 'You must specify a command')
  .strict()
  .help()
  .parse();
