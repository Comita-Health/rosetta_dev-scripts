import { inject, injectable } from 'inversify';
import chalk from 'chalk';
import type { IDropService } from '../services/drop.service';
import type { IEnvelopeGateService } from '../services/envelope-gate.service';
import { WORKFLOW_TOKENS } from '../tokens';
import { DropInput, DropState, DropTask } from '../types';

export interface DropHandlerInput extends DropInput {
  finish: boolean;
  tasks?: DropTask[];
}

export interface IDropHandler {
  /**
   * Arm a drop worktree; with `finish`, open one PR and (for direct)
   * merge on green machine gates. No business logic — parse and dispatch.
   */
  run(input: DropHandlerInput): Promise<DropState>;
}

@injectable()
export class DropHandler implements IDropHandler {
  constructor(
    @inject(WORKFLOW_TOKENS.DropService)
    private readonly _dropService: IDropService,
    @inject(WORKFLOW_TOKENS.EnvelopeGateService)
    private readonly _envelopeGate: IEnvelopeGateService
  ) {}

  async run(input: DropHandlerInput): Promise<DropState> {
    console.log(chalk.bold(`\nDrop ${input.dropId}\n`));
    let state = this._dropService.arm(input);
    console.log(chalk.green(`  ✓ worktree ${state.worktreePath}`));
    console.log(chalk.gray(`    branch ${state.branch} @ ${state.baseSha}`));

    if (!input.finish) {
      console.log(
        chalk.gray(
          '  implement as commits in the worktree, then `drop --finish`'
        )
      );
      return state;
    }

    state = this._dropService.openPr(
      input.dropsDir,
      state.dropId,
      input.tasks
    );
    console.log(
      chalk.green(`  ✓ PR ${state.prUrl ?? '(unknown)'} (one PR per drop)`)
    );

    if (state.envelope !== undefined) {
      const verdict = await this._envelopeGate.evaluate({
        repoPath: state.worktreePath,
        baseRef: state.baseSha,
        headRef: state.branch,
        envelope: state.envelope
      });
      for (const note of verdict.notes ?? []) {
        console.log(chalk.yellow(`  ⚠ ${note}`));
      }
      if (verdict.outcome !== 'pass') {
        console.log(
          chalk.red(`  ✗ envelope: ${verdict.reasons.join('; ')}`)
        );
        return state;
      }
    }

    if (state.mode === 'direct' && !state.requireApprove) {
      state = this._dropService.mergeDirect(input.dropsDir, state.dropId);
      console.log(
        chalk.green(
          `  ✓ merged on machine gates at ${state.mergedSha?.slice(0, 12)}`
        )
      );
    } else {
      console.log(
        chalk.gray(
          '  waiting for human Approve (`--require-approve` or non-direct)'
        )
      );
    }
    return state;
  }
}
