import { inject, injectable } from 'inversify';
import chalk from 'chalk';
import type { IPrdRepository } from '../repositories/prd.repository';
import type { ISpecFileRepository } from '../repositories/spec-file.repository';
import type { IDecomposeService } from '../services/decompose.service';
import type { ISpecSynthesisService } from '../services/spec-synthesis.service';
import { WORKFLOW_TOKENS } from '../tokens';
import { WorkflowInput } from '../types';

export interface IWorkflowHandler {
  /**
   * PRD-0011 rollout Phase 1: parse the PRD, decompose into stories,
   * synthesize the implementation spec, write it to the target repo as
   * Draft, and stop. The human gate (Draft → Approved) is a hard stop by
   * construction — this handler has no further steps.
   */
  runDecompose(input: WorkflowInput): Promise<string>;
}

@injectable()
export class WorkflowHandler implements IWorkflowHandler {
  constructor(
    @inject(WORKFLOW_TOKENS.PrdRepository)
    private readonly _prdRepo: IPrdRepository,
    @inject(WORKFLOW_TOKENS.SpecFileRepository)
    private readonly _specRepo: ISpecFileRepository,
    @inject(WORKFLOW_TOKENS.DecomposeService)
    private readonly _decompose: IDecomposeService,
    @inject(WORKFLOW_TOKENS.SpecSynthesisService)
    private readonly _synthesis: ISpecSynthesisService
  ) {}

  async runDecompose(input: WorkflowInput): Promise<string> {
    console.log(chalk.bold(`\nDecomposing ${input.prdId}...\n`));

    const prd = await this._prdRepo.getPrd(input.prdId, input.docsDir);
    console.log(chalk.gray(`  PRD: ${prd.id} — ${prd.title}`));

    const stories = await this._decompose.decompose(prd);
    console.log(chalk.green(`  ✓ ${stories.length} product stories`));

    const phaseTitle =
      prd.rolloutPhases.find(p => p.number === input.phase)?.title ??
      `Phase ${input.phase}`;
    const spec = await this._synthesis.synthesize(stories, {
      prdId: input.prdId,
      phase: input.phase,
      phaseTitle,
      owner: prd.owner,
      budgetK: input.budgetK,
      date: new Date().toISOString().slice(0, 10),
      repoPath: input.repoPath
    });
    console.log(
      chalk.green(`  ✓ ${spec.specId}: ${spec.tasks.length} tasks synthesized`)
    );
    for (const warning of spec.warnings) {
      console.log(chalk.yellow(`  ⚠ ${warning}`));
    }

    const specPath = this._specRepo.writeSpec(
      input.repoPath,
      input.prdId,
      input.phase,
      spec.markdown
    );
    console.log(chalk.green(`  ✓ Spec written (Draft) → ${specPath}`));

    console.log(chalk.bold('\n[HUMAN GATE] Workflow stopped by design.'));
    console.log('  1. Review the Draft spec (tasks, criteria, envelope).');
    console.log(
      '  2. Approve by flipping status: Draft → Approved in a dedicated'
    );
    console.log(
      '     commit (docs: approve ' + spec.specId + ') — see ADR-0008.'
    );
    console.log('  3. Implementation may begin only against an Approved spec.');

    return specPath;
  }
}
