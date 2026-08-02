import { appendFileSync, mkdirSync, writeFileSync } from 'fs';
import { inject, injectable } from 'inversify';
import path from 'path';
import chalk from 'chalk';
import type { IProcessDetachRepository } from '../repositories/process-detach.repository';
import type { IRunStateRepository } from '../repositories/run-state.repository';
import type { ISpecDocRepository } from '../repositories/spec-doc.repository';
import type {
  IRunHandler,
  RunTaskInput,
  RunTaskResult
} from '../handlers/run.handler';
import { WORKFLOW_TOKENS } from '../tokens';
import {
  allTasksMerged,
  hasMergeBlockedHalt,
  hasUnmergedCompletedTasks
} from '../utils/run-completion';
import { buildSuperviseChildArgv } from '../utils/supervise-argv';
import type { IHeartbeatWatchService } from './heartbeat-watch.service';

export interface SuperviseInput extends RunTaskInput {
  /**
   * Loop waves until all tasks merge (enforce) or a terminal gate/human
   * stop. Recommended operator default; may become CLI default later.
   */
  supervise: boolean;
  /**
   * Spawn a detached supervise child and return immediately (#38). Implies
   * supervise in the child. Parent prints PID + monitor paths then exits.
   */
  detach: boolean;
  /** Cap on wave iterations (default 20). */
  maxWaves?: number;
  /** Optional override for the live monitor log path. */
  monitorPath?: string;
  /**
   * Argv for the detached child (defaults to `process.argv`). Tests inject a
   * synthetic `run …` argv; production leaves this unset.
   */
  detachArgv?: string[];
}

export interface SuperviseResult {
  kind: 'detached' | 'completed' | 'stopped' | 'failed';
  waves: number;
  pid?: number;
  monitorPath?: string;
  logPath?: string;
  lastWave?: RunTaskResult;
  detail?: string;
}

/**
 * Operator supervise loop: auto-resume dependency waves after enforce merges,
 * mirror heartbeats into a live monitor log, and optionally detach so agent
 * shells cannot kill the run (Comita live-val / #38 / #39).
 */
export interface ISuperviseService {
  run(input: SuperviseInput): Promise<SuperviseResult>;
}

@injectable()
export class SuperviseService implements ISuperviseService {
  constructor(
    @inject(WORKFLOW_TOKENS.RunHandler)
    private readonly _runHandler: IRunHandler,
    @inject(WORKFLOW_TOKENS.SpecDocRepository)
    private readonly _specDocRepo: ISpecDocRepository,
    @inject(WORKFLOW_TOKENS.RunStateRepository)
    private readonly _runStateRepo: IRunStateRepository,
    @inject(WORKFLOW_TOKENS.ProcessDetachRepository)
    private readonly _detachRepo: IProcessDetachRepository,
    @inject(WORKFLOW_TOKENS.HeartbeatWatchService)
    private readonly _hbWatch: IHeartbeatWatchService
  ) {}

  async run(input: SuperviseInput): Promise<SuperviseResult> {
    if (input.detach === true) {
      return this.detach(input);
    }
    if (input.supervise !== true) {
      const lastWave = await this._runHandler.runTask(input);
      return {
        kind: this.mapWaveKind(lastWave, input),
        waves: 1,
        lastWave
      };
    }
    return this.loop(input);
  }

  /**
   * Record how this run was launched so an external supervisor (the launchd
   * continuity daemon) can relaunch it after a crash. Without this the run
   * directory has a dead `supervise.pid` and no way to reconstruct the
   * invocation, so a died supervisor can only be restarted by a human who
   * remembers the original command.
   */
  private writeLaunchRecord(input: SuperviseInput, childArgv: string[]): void {
    const runDir = path.join(input.runsDir, input.runId);
    writeFileSync(
      path.join(runDir, 'launch.json'),
      JSON.stringify(
        {
          runId: input.runId,
          specPath: input.specPath,
          repoPath: input.repoPath,
          chronicleRepo: input.chronicleRepo,
          runsDir: input.runsDir,
          shadow: input.shadow === true,
          cwd: process.cwd(),
          execPath: process.execPath,
          argv: childArgv,
          recordedAt: new Date().toISOString()
        },
        null,
        2
      ) + '\n'
    );
  }

  private detach(input: SuperviseInput): SuperviseResult {
    const runDir = path.join(input.runsDir, input.runId);
    mkdirSync(runDir, { recursive: true });
    const logPath = path.join(runDir, 'supervise.log');
    const monitorPath = input.monitorPath ?? path.join(runDir, 'monitor.log');
    const pidPath = path.join(runDir, 'supervise.pid');

    const childArgv = buildSuperviseChildArgv(input.detachArgv ?? process.argv);
    this.writeLaunchRecord(input, childArgv);
    const { pid } = this._detachRepo.spawnDetached({
      command: process.execPath,
      args: childArgv,
      cwd: process.cwd(),
      logPath,
      env: {
        ...process.env,
        SDLC_SUPERVISE_MONITOR: monitorPath
      }
    });

    writeFileSync(pidPath, `${pid}\n`);
    this._hbWatch.note(
      monitorPath,
      `[supervise] detached pid=${pid} runId=${input.runId} log=${logPath}`
    );

    console.log(chalk.bold('\n[supervise] detached'));
    console.log(`  pid:     ${pid}`);
    console.log(`  runId:   ${input.runId}`);
    console.log(`  log:     ${logPath}`);
    console.log(`  monitor: ${monitorPath}`);
    console.log(`  pidfile: ${pidPath}`);
    console.log(
      chalk.gray('  Child runs with --supervise (wave auto-resume + hb watch).')
    );

    return {
      kind: 'detached',
      waves: 0,
      pid,
      monitorPath,
      logPath
    };
  }

  private async loop(input: SuperviseInput): Promise<SuperviseResult> {
    const maxWaves = input.maxWaves ?? 20;
    const runDir = path.join(input.runsDir, input.runId);
    mkdirSync(runDir, { recursive: true });
    const monitorPath =
      input.monitorPath ??
      process.env.SDLC_SUPERVISE_MONITOR ??
      path.join(runDir, 'monitor.log');
    const heartbeatPath = path.join(runDir, 'heartbeat.jsonl');

    writeFileSync(path.join(runDir, 'supervise.pid'), `${process.pid}\n`);
    // The detached child re-enters here; re-record so the launch metadata
    // reflects the process that actually owns the pidfile.
    this.writeLaunchRecord(input, (process.argv ?? []).slice(1));
    this._hbWatch.start({
      heartbeatPath,
      monitorPath,
      pollMs: 1000
    });

    let waves = 0;
    let lastWave: RunTaskResult | undefined;

    try {
      while (waves < maxWaves) {
        waves += 1;
        this._hbWatch.note(
          monitorPath,
          `[supervise] wave ${waves} start ${new Date().toISOString()}`
        );
        console.log(chalk.bold(`\n[supervise] wave ${waves}/${maxWaves}`));

        lastWave = await this._runHandler.runTask(input);

        const spec = this._specDocRepo.read(input.specPath);
        const state = this._runStateRepo.load(input.runsDir, input.runId);

        if (allTasksMerged(spec, state)) {
          this._hbWatch.note(
            monitorPath,
            `[supervise] ALL TASKS MERGED after wave ${waves}`
          );
          console.log(chalk.green('\n[supervise] all tasks merged — done'));
          return {
            kind: 'completed',
            waves,
            lastWave,
            monitorPath,
            detail: 'all-tasks-merged'
          };
        }

        const anyFailed = lastWave.tasks.some(t => t.kind === 'failed');
        if (lastWave.outcome === 'blocked' || anyFailed) {
          this._hbWatch.note(
            monitorPath,
            `[supervise] stopped wave ${waves}: ${lastWave.outcome} failed=${anyFailed}`
          );
          return {
            kind: 'failed',
            waves,
            lastWave,
            monitorPath,
            detail: anyFailed ? 'task-failed' : 'blocked'
          };
        }

        // Enforce: completed-but-unmerged after a red phase is a hard stop —
        // do not spin another "no ready task" wave (Comita Phase 0b lesson).
        if (
          input.shadow !== true &&
          hasMergeBlockedHalt(
            state,
            lastWave.tasks.map(task => task.taskId)
          )
        ) {
          this._hbWatch.note(
            monitorPath,
            `[supervise] MERGE BLOCKED after wave ${waves} — escalate / fix gates, then resume`
          );
          console.log(
            chalk.red(
              '\n[supervise] merge blocked — fix red gates or PR conflicts, then resume'
            )
          );
          return {
            kind: 'failed',
            waves,
            lastWave,
            monitorPath,
            detail: 'merge-blocked'
          };
        }

        // Shadow mode: merges are human — stop after the wave for review.
        if (input.shadow === true && hasUnmergedCompletedTasks(state)) {
          this._hbWatch.note(
            monitorPath,
            `[supervise] HUMAN GATE (shadow) after wave ${waves} — merge + record-merge, then resume`
          );
          console.log(
            chalk.bold(
              '\n[supervise] shadow human gate — merge task PRs, record-merge, re-run with --supervise'
            )
          );
          return {
            kind: 'stopped',
            waves,
            lastWave,
            monitorPath,
            detail: 'shadow-human-gate'
          };
        }

        if (lastWave.outcome === 'no-ready-task') {
          this._hbWatch.note(
            monitorPath,
            `[supervise] no ready task and not all merged after wave ${waves}`
          );
          return {
            kind: 'stopped',
            waves,
            lastWave,
            monitorPath,
            detail: 'no-ready-task'
          };
        }

        // Enforce wave merged something (or cached) — continue for dependents.
        appendFileSync(
          monitorPath,
          `[supervise] wave ${waves} complete — resuming for dependents\n`
        );
      }

      return {
        kind: 'failed',
        waves,
        lastWave,
        monitorPath,
        detail: `max-waves-${maxWaves}`
      };
    } finally {
      this._hbWatch.note(
        monitorPath,
        `[hb-watch] stopped ${new Date().toISOString()}`
      );
      this._hbWatch.stop();
    }
  }

  private mapWaveKind(
    lastWave: RunTaskResult,
    input: SuperviseInput
  ): SuperviseResult['kind'] {
    if (lastWave.outcome === 'blocked') {
      return 'failed';
    }
    if (lastWave.tasks.some(t => t.kind === 'failed')) {
      return 'failed';
    }
    const spec = this._specDocRepo.read(input.specPath);
    const state = this._runStateRepo.load(input.runsDir, input.runId);
    if (allTasksMerged(spec, state)) {
      return 'completed';
    }
    return 'stopped';
  }
}
