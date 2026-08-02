#!/usr/bin/env node
import 'reflect-metadata';
import { Container } from 'inversify';
import path from 'path';
import chalk from 'chalk';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import os from 'os';
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
  RunStateRepository,
  IRunStateRepository
} from './repositories/run-state.repository';
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
  SuperviseService,
  ISuperviseService
} from './services/supervise.service';
import { WORKFLOW_TOKENS } from './tokens';
import { WorkflowError } from './types';
import { resolveInferenceBackend } from './utils/backend-select';

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
  .bind<IRunStateRepository>(WORKFLOW_TOKENS.RunStateRepository)
  .to(RunStateRepository);
container
  .bind<ISurfaceMapRepository>(WORKFLOW_TOKENS.SurfaceMapRepository)
  .to(SurfaceMapRepository);
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
  .bind<IPrLifecycleService>(WORKFLOW_TOKENS.PrLifecycleService)
  .to(PrLifecycleService);
container
  .bind<IEscalationService>(WORKFLOW_TOKENS.EscalationService)
  .to(EscalationService);
container
  .bind<IHeartbeatService>(WORKFLOW_TOKENS.HeartbeatService)
  .to(HeartbeatService);
container
  .bind<IHeartbeatWatchService>(WORKFLOW_TOKENS.HeartbeatWatchService)
  .to(HeartbeatWatchService);
container
  .bind<IProcessDetachRepository>(WORKFLOW_TOKENS.ProcessDetachRepository)
  .to(ProcessDetachRepository);
container.bind<IRunHandler>(WORKFLOW_TOKENS.RunHandler).to(RunHandler);
container
  .bind<ISuperviseService>(WORKFLOW_TOKENS.SuperviseService)
  .to(SuperviseService);

yargs(hideBin(process.argv))
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
          monitorPath: argv.monitor
        });
        if (result.kind === 'detached') {
          process.exit(0);
        }
        if (result.kind === 'failed') {
          process.exit(1);
        }
        const last = result.lastWave;
        if (last !== undefined) {
          const anyFailed = last.tasks.some(task => task.kind === 'failed');
          if (last.outcome === 'blocked' || anyFailed) {
            process.exit(1);
          }
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
    'status',
    'Show a run: task results, cached step graph, verdicts, exceptions (T-09)',
    y =>
      y
        .option('run-id', {
          type: 'string',
          demandOption: true,
          describe: 'Run identifier to inspect'
        })
        .option('runs-dir', {
          type: 'string',
          default: path.join(os.homedir(), '.rosetta', 'sdlc-runs'),
          describe: 'Directory holding run state'
        }),
    argv => {
      const handler = container.get<IRunHandler>(WORKFLOW_TOKENS.RunHandler);
      try {
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
