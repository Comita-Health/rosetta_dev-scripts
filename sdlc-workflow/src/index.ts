#!/usr/bin/env node
import 'reflect-metadata';
import { Container } from 'inversify';
import path from 'path';
import chalk from 'chalk';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { WorkflowHandler, IWorkflowHandler } from './handlers/workflow.handler';
import {
  AnthropicRepository,
  IAnthropicRepository
} from './repositories/anthropic.repository';
import {
  InferenceRepository,
  IInferenceRepository
} from './repositories/inference.repository';
import { PrdRepository, IPrdRepository } from './repositories/prd.repository';
import {
  SpecFileRepository,
  ISpecFileRepository
} from './repositories/spec-file.repository';
import {
  DecomposeService,
  IDecomposeService
} from './services/decompose.service';
import {
  SpecSynthesisService,
  ISpecSynthesisService
} from './services/spec-synthesis.service';
import { WORKFLOW_TOKENS } from './tokens';
import { WorkflowError } from './types';

const container = new Container();
container
  .bind<IAnthropicRepository>(WORKFLOW_TOKENS.AnthropicRepository)
  .to(AnthropicRepository);
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
  .demandCommand(1, 'You must specify a command')
  .strict()
  .help()
  .parse();
