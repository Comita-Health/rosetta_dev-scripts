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
container.bind<IRunHandler>(WORKFLOW_TOKENS.RunHandler).to(RunHandler);

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
    'Execute one ready task from an Approved spec (shadow-mode gates, halts for human review)',
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
        }),
    async argv => {
      const handler = container.get<IRunHandler>(WORKFLOW_TOKENS.RunHandler);
      const runId =
        argv['run-id'] ??
        `${path
          .basename(argv.spec)
          .replace(/\.md$/, '')}-${new Date().toISOString().slice(0, 10)}`;
      try {
        const result = await handler.runTask({
          specPath: argv.spec,
          repoPath: argv.repo,
          runId,
          runsDir: argv['runs-dir'],
          chronicleRepo: argv['chronicle-repo']
        });
        if (result.outcome === 'blocked' || result.outcome === 'failed') {
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
          mergedSha: argv.sha
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
