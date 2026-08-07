import { inject, injectable } from 'inversify';
import chalk from 'chalk';
import type {
  DaemonInstallOptions,
  DaemonInstallResult,
  IDaemonLifecycleService
} from '../services/daemon-lifecycle.service';
import {
  formatWatchTarget,
  type IDaemonStatusService
} from '../services/daemon-status.service';
import { WORKFLOW_TOKENS } from '../tokens';
import type { DaemonRuntimePaths, DaemonStatusReport } from '../types';
import { WorkflowError } from '../types';

export interface DaemonCommandInput {
  workspaceRoot: string | undefined;
  plistDir?: string;
  load?: boolean;
  /** Absolute path to this CLI entry (passed from `index.ts` as `__filename`). */
  cliEntry?: string;
  program?: string;
}

export interface DaemonStatusCommandInput {
  workspaceRoot: string | undefined;
  /** When true, print the status report as a single JSON object. */
  json?: boolean;
}

/**
 * CLI entry for `sdlc-workflow daemon` — parses args and delegates lifecycle
 * to {@link IDaemonLifecycleService}. No business logic beyond fail-fast
 * validation of the required workspace root (SPEC-PRD-0020-P1 T-01).
 * Status (T-07) delegates assembly to {@link IDaemonStatusService}.
 */
export interface IDaemonHandler {
  /**
   * Start the long-running daemon for one workspace: load `DaemonConfig`,
   * write pid/log paths, then block until SIGTERM/SIGINT.
   *
   * @throws {WorkflowError} `DAEMON_CONFIG_INVALID` when `--workspace` is
   *   missing/empty (no partial state) or when config under the root is
   *   missing/malformed.
   */
  run(input: DaemonCommandInput): Promise<DaemonRuntimePaths>;
  /**
   * Generate and load a KeepAlive=true launchd agent for the workspace.
   * Creates `.sdlc/daemon/` + log before bootstrap so launchd can open
   * StandardOutPath/StandardErrorPath. Load is transactional: a failed
   * `launchctl enable` after bootstrap boots out and removes the plist.
   *
   * @throws {WorkflowError} `DAEMON_CONFIG_INVALID` when `--workspace` is
   *   missing/empty, config is invalid, or launchctl bootstrap/enable fails.
   */
  install(input: DaemonCommandInput): DaemonInstallResult;
  /**
   * Unload and remove the workspace launchd agent. Label/plist path are
   * derived from the workspace root alone so a missing or malformed
   * `.sdlc/daemon.json` cannot strand an orphaned agent.
   *
   * @throws {WorkflowError} `DAEMON_CONFIG_INVALID` when `--workspace` is
   *   missing/empty (no launchctl calls).
   */
  uninstall(input: DaemonCommandInput): { label: string };
  /**
   * Render watch registry + wake inbox status (human table or `--json`).
   *
   * @throws {WorkflowError} `DAEMON_CONFIG_INVALID` when `--workspace` is
   *   missing/empty or the daemon contract under the root is unusable.
   */
  status(input: DaemonStatusCommandInput): DaemonStatusReport;
}

@injectable()
export class DaemonHandler implements IDaemonHandler {
  constructor(
    @inject(WORKFLOW_TOKENS.DaemonLifecycleService)
    private readonly _lifecycle: IDaemonLifecycleService,
    @inject(WORKFLOW_TOKENS.DaemonStatusService)
    private readonly _status: IDaemonStatusService
  ) {}

  /**
   * Start the long-running daemon for one workspace: load `DaemonConfig`,
   * write pid/log paths, then block until SIGTERM/SIGINT.
   *
   * @throws {WorkflowError} `DAEMON_CONFIG_INVALID` when `--workspace` is
   *   missing/empty (no partial state) or when config under the root is
   *   missing/malformed.
   */
  async run(input: DaemonCommandInput): Promise<DaemonRuntimePaths> {
    const workspaceRoot = this.requireWorkspace(input.workspaceRoot);
    console.log(chalk.bold('\nStarting SDLC event daemon...\n'));
    console.log(chalk.gray(`  workspace: ${workspaceRoot}`));
    const paths = await this._lifecycle.run(workspaceRoot);
    console.log(chalk.green('  ✓ daemon stopped cleanly'));
    return paths;
  }

  /**
   * Generate and load a KeepAlive=true launchd agent for the workspace.
   * Creates `.sdlc/daemon/` + log before bootstrap so launchd can open
   * StandardOutPath/StandardErrorPath. Load is transactional: a failed
   * `launchctl enable` after bootstrap boots out and removes the plist.
   *
   * @throws {WorkflowError} `DAEMON_CONFIG_INVALID` when `--workspace` is
   *   missing/empty, config is invalid, or launchctl bootstrap/enable fails.
   */
  install(input: DaemonCommandInput): DaemonInstallResult {
    const workspaceRoot = this.requireWorkspace(input.workspaceRoot);
    const options: DaemonInstallOptions = {
      plistDir: input.plistDir,
      load: input.load,
      cliEntry: input.cliEntry,
      program: input.program
    };
    const result = this._lifecycle.install(workspaceRoot, options);
    console.log(chalk.bold('\nInstalled launchd daemon agent\n'));
    console.log(chalk.gray(`  label:  ${result.label}`));
    console.log(chalk.gray(`  plist:  ${result.plistPath}`));
    console.log(chalk.gray(`  log:    ${result.paths.logPath}`));
    console.log(chalk.gray(`  pid:    ${result.paths.pidFile}`));
    console.log(
      chalk.gray(
        `  loaded: ${result.loaded ? 'yes (KeepAlive=true)' : 'plist only'}`
      )
    );
    return result;
  }

  /**
   * Unload and remove the workspace launchd agent. Label/plist path are
   * derived from the workspace root alone so a missing or malformed
   * `.sdlc/daemon.json` cannot strand an orphaned agent.
   *
   * @throws {WorkflowError} `DAEMON_CONFIG_INVALID` when `--workspace` is
   *   missing/empty (no launchctl calls).
   */
  uninstall(input: DaemonCommandInput): { label: string } {
    const workspaceRoot = this.requireWorkspace(input.workspaceRoot);
    const result = this._lifecycle.uninstall(workspaceRoot, {
      plistDir: input.plistDir
    });
    console.log(chalk.green(`\n✓ Uninstalled ${result.label}\n`));
    return result;
  }

  /**
   * Query the watch registry and wake inbox; print a human table or JSON.
   *
   * @throws {WorkflowError} `DAEMON_CONFIG_INVALID` when `--workspace` is
   *   missing/empty or the daemon contract under the root is unusable.
   */
  status(input: DaemonStatusCommandInput): DaemonStatusReport {
    const workspaceRoot = this.requireWorkspace(input.workspaceRoot);
    const report = this._status.build(workspaceRoot);
    if (input.json === true) {
      console.log(JSON.stringify(report, null, 2));
      return report;
    }
    this.renderTable(report);
    return report;
  }

  private renderTable(report: DaemonStatusReport): void {
    console.log(chalk.bold(`\nDaemon status — ${report.workspaceRoot}\n`));

    console.log(chalk.bold(`Watches (${report.watches.length})`));
    if (report.watches.length === 0) {
      console.log('  (none)');
    } else {
      for (const watch of report.watches) {
        const health =
          watch.degraded === true
            ? chalk.yellow('DEGRADED')
            : chalk.green('healthy');
        const poll = watch.lastPollTime === null ? 'never' : watch.lastPollTime;
        console.log(
          `  [${health}] ${watch.kind} ${formatWatchTarget(watch.target)}` +
            chalk.gray(` age=${watch.age}s lastPoll=${poll}`)
        );
        if (watch.degraded === true && watch.lastError !== null) {
          console.log(chalk.yellow(`           lastError: ${watch.lastError}`));
        }
      }
    }

    console.log(chalk.bold(`\nWakes (${report.wakes.length})`));
    if (report.wakes.length === 0) {
      console.log('  (none)');
    } else {
      for (const wake of report.wakes) {
        const stateLabel =
          wake.state === 'pending'
            ? chalk.cyan('pending')
            : chalk.gray('consumed');
        const by =
          wake.consumedBy === null ? '' : chalk.gray(` by=${wake.consumedBy}`);
        console.log(
          `  [${stateLabel}] ${wake.kind} ${wake.target} signal=${wake.signal}` +
            by
        );
      }
    }

    console.log(chalk.bold(`\nUnwatched (${report.unwatched.length})`));
    if (report.unwatched.length === 0) {
      console.log('  (none)');
    } else {
      for (const entry of report.unwatched) {
        console.log(
          `  ${entry.kind} ${formatWatchTarget(entry.target)}` +
            chalk.gray(` source=${entry.source}`)
        );
      }
    }
    console.log('');
  }

  /**
   * Fail fast with no side effects when the workspace root is absent — the
   * acceptance criterion requires a non-zero exit and no partial state.
   */
  private requireWorkspace(workspaceRoot: string | undefined): string {
    if (
      workspaceRoot === undefined ||
      typeof workspaceRoot !== 'string' ||
      workspaceRoot.trim().length === 0
    ) {
      throw new WorkflowError(
        'daemon requires --workspace <path>',
        'DAEMON_CONFIG_INVALID'
      );
    }
    return workspaceRoot.trim();
  }
}
