import { inject, injectable } from 'inversify';
import chalk from 'chalk';
import type { IDaemonConfigRepository } from '../repositories/daemon-config.repository';
import type {
  DaemonInstallOptions,
  DaemonInstallResult,
  IDaemonLifecycleService
} from '../services/daemon-lifecycle.service';
import {
  formatWatchTarget,
  type IDaemonStatusService
} from '../services/daemon-status.service';
import type {
  ILegacyWakeMigrateService,
  LegacyWakeMigrateDisposition,
  LegacyWakeMigrateReport
} from '../services/legacy-wake-migrate.service';
import type { IWatchRegistryService } from '../services/watch-registry.service';
import { WORKFLOW_TOKENS } from '../tokens';
import type {
  DaemonRuntimePaths,
  DaemonStatusReport,
  DurableWatchRecord,
  WatchKind
} from '../types';
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

export interface DaemonWatchCommandInput {
  workspaceRoot: string | undefined;
  /** Watch kind; only the PR-shaped kinds in {@link PR_WATCH_KINDS} register here. */
  kind: string;
  /** Positional `owner/repo#N` targets. */
  targets: string[];
  /** Override poll cadence; defaults to workspace `defaultPollSeconds`. */
  pollSeconds?: number;
  /** Who registered the watch (skill id or operator). */
  createdBy?: string;
  /** When true, print registered records as JSON. */
  json?: boolean;
}

export interface DaemonMigrateWakeCommandInput {
  workspaceRoot: string | undefined;
  /** Legacy wake root (`…/wake`). Defaults to `$ROSETTA_WAKE_DIR`. */
  from?: string;
  /** How to leave migrated wakes; default `auto`. */
  disposition?: LegacyWakeMigrateDisposition;
  /** Map and report without writing or archiving. */
  dryRun?: boolean;
  /** When true, print the migrate report as JSON. */
  json?: boolean;
}

/**
 * The only kinds this command can register.
 *
 * @remarks
 * Every target is parsed with {@link parsePrWatchTarget}, so the command may
 * only advertise kinds whose target really is `owner/repo#N`. `workflow-run`,
 * `run-supervisor`, and `queue-item` are identified by run id, so this
 * grammar cannot express them at all. `issue-state` shares the same target
 * shape and is polled by {@link IssueStateWatchSourceAdapter}.
 */
export const PR_WATCH_KINDS: readonly WatchKind[] = [
  'pr-review',
  'pr-checks',
  'issue-state'
];

const PR_TARGET_PATTERN = /^([^/#\s]+\/[^/#\s]+)#([1-9][0-9]*)$/;

/**
 * Narrow a CLI `--kind` string to a kind this command can actually parse.
 *
 * @throws {WorkflowError} `DAEMON_WATCH_INVALID` for an unknown kind, or for a
 *   registry kind outside {@link PR_WATCH_KINDS}.
 */
const requirePrWatchKind = (kind: string): WatchKind => {
  const match = PR_WATCH_KINDS.find(candidate => candidate === kind);
  if (match === undefined) {
    throw new WorkflowError(
      `daemon watch --kind must be one of ${PR_WATCH_KINDS.join(', ')} ` +
        `(got ${JSON.stringify(kind)}); the remaining watch kinds are not ` +
        'registrable from this owner/repo#N command',
      'DAEMON_WATCH_INVALID'
    );
  }
  return match;
};

/**
 * Parse a skill/CLI `owner/repo#N` target into structured fields.
 *
 * @throws {WorkflowError} `DAEMON_WATCH_INVALID` when the token is malformed.
 */
export const parsePrWatchTarget = (
  raw: string
): { repo: string; number: number } => {
  const match = PR_TARGET_PATTERN.exec(raw.trim());
  if (match === null) {
    throw new WorkflowError(
      `daemon watch target must be owner/repo#N (got ${JSON.stringify(raw)})`,
      'DAEMON_WATCH_INVALID'
    );
  }
  return { repo: match[1], number: Number.parseInt(match[2], 10) };
};

/**
 * CLI entry for `sdlc-workflow daemon` — parses args and delegates lifecycle
 * to {@link IDaemonLifecycleService}. No business logic beyond fail-fast
 * validation of the required workspace root (SPEC-PRD-0020-P1 T-01).
 * Status (T-07) delegates assembly to {@link IDaemonStatusService}.
 * Watch registration (T-08) delegates to {@link IWatchRegistryService}.
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
  /**
   * Register one or more durable watches and exit (SPEC-PRD-0020-P1 T-08).
   *
   * @remarks
   * Identity is kind + target; re-registering an active watch is a no-op read.
   * Polling stays in the long-lived daemon — this CLI never sleeps. Only the
   * `owner/repo#N` kinds in {@link PR_WATCH_KINDS} may be registered here.
   *
   * @throws {WorkflowError} `DAEMON_CONFIG_INVALID` when `--workspace` is
   *   missing/empty or the daemon contract is unusable.
   * @throws {WorkflowError} `DAEMON_WATCH_INVALID` when kind/targets/cadence
   *   are malformed.
   */
  watch(input: DaemonWatchCommandInput): DurableWatchRecord[];
  /**
   * Import stranded `~/.rosetta/wake/pending` files into `.sdlc/daemon/wake`
   * so the KeepAlive consumer can drain them.
   *
   * @throws {WorkflowError} `DAEMON_CONFIG_INVALID` when `--workspace` is
   *   missing/empty or the daemon contract is unusable.
   * @throws {WorkflowError} `DAEMON_WATCH_INVALID` when `--disposition` is
   *   not one of `auto` / `pending` / `consumed`.
   */
  migrateWake(
    input: DaemonMigrateWakeCommandInput
  ): Promise<LegacyWakeMigrateReport>;
}

@injectable()
export class DaemonHandler implements IDaemonHandler {
  constructor(
    @inject(WORKFLOW_TOKENS.DaemonLifecycleService)
    private readonly _lifecycle: IDaemonLifecycleService,
    @inject(WORKFLOW_TOKENS.DaemonStatusService)
    private readonly _status: IDaemonStatusService,
    @inject(WORKFLOW_TOKENS.WatchRegistryService)
    private readonly _registry: IWatchRegistryService,
    @inject(WORKFLOW_TOKENS.DaemonConfigRepository)
    private readonly _config: IDaemonConfigRepository,
    @inject(WORKFLOW_TOKENS.LegacyWakeMigrateService)
    private readonly _migrate: ILegacyWakeMigrateService
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

  /**
   * Register durable watches for each `owner/repo#N` target and exit.
   *
   * @throws {WorkflowError} `DAEMON_CONFIG_INVALID` / `DAEMON_WATCH_INVALID`
   *   on missing workspace, a kind outside {@link PR_WATCH_KINDS}, empty
   *   targets, or a malformed target/cadence.
   */
  watch(input: DaemonWatchCommandInput): DurableWatchRecord[] {
    const workspaceRoot = this.requireWorkspace(input.workspaceRoot);
    const kind = requirePrWatchKind(input.kind);
    if (input.targets.length === 0) {
      throw new WorkflowError(
        'daemon watch requires at least one owner/repo#N target',
        'DAEMON_WATCH_INVALID'
      );
    }

    const resolved = this._config.load(workspaceRoot);
    const pollSeconds =
      input.pollSeconds !== undefined
        ? input.pollSeconds
        : resolved.config.defaultPollSeconds;
    if (
      typeof pollSeconds !== 'number' ||
      Number.isNaN(pollSeconds) ||
      pollSeconds <= 0
    ) {
      throw new WorkflowError(
        'daemon watch --poll-seconds must be a positive number',
        'DAEMON_WATCH_INVALID'
      );
    }

    const createdBy =
      input.createdBy !== undefined && input.createdBy.trim().length > 0
        ? input.createdBy.trim()
        : 'cli';

    const records: DurableWatchRecord[] = [];
    for (const raw of input.targets) {
      const target = parsePrWatchTarget(raw);
      try {
        records.push(
          this._registry.register(workspaceRoot, {
            kind,
            target,
            pollSeconds,
            createdBy
          })
        );
      } catch (error) {
        if (error instanceof TypeError) {
          throw new WorkflowError(error.message, 'DAEMON_WATCH_INVALID');
        }
        throw error;
      }
    }

    if (input.json === true) {
      console.log(JSON.stringify(records, null, 2));
      return records;
    }

    console.log(chalk.bold(`\nRegistered ${records.length} watch(es)\n`));
    for (const record of records) {
      console.log(
        `  ${record.kind} ${formatWatchTarget(record.target)}` +
          chalk.gray(
            ` id=${record.id} poll=${record.pollSeconds}s by=${record.createdBy}`
          )
      );
    }
    console.log('');
    return records;
  }

  /**
   * Move legacy session wake files into the daemon ledger and archive the
   * sources under the legacy `consumed/` tree.
   */
  async migrateWake(
    input: DaemonMigrateWakeCommandInput
  ): Promise<LegacyWakeMigrateReport> {
    const workspaceRoot = this.requireWorkspace(input.workspaceRoot);
    // Touch the contract so a missing `.sdlc/daemon.json` fails before any
    // legacy file is rewritten.
    this._config.load(workspaceRoot);
    const disposition = this.requireDisposition(input.disposition);
    const report = await this._migrate.migrate(workspaceRoot, {
      fromWakeDir: input.from,
      disposition,
      dryRun: input.dryRun === true
    });

    if (input.json === true) {
      console.log(JSON.stringify(report, null, 2));
      return report;
    }

    const pending = report.items.filter(
      item => item.disposition === 'pending'
    ).length;
    const consumed = report.items.filter(
      item => item.disposition === 'consumed'
    ).length;
    const dry = report.items.filter(
      item => item.disposition === 'dry-run'
    ).length;
    console.log(chalk.bold('\nMigrated legacy wake inbox\n'));
    console.log(chalk.gray(`  from:      ${report.fromWakeDir}`));
    console.log(chalk.gray(`  workspace: ${report.workspaceRoot}`));
    console.log(chalk.gray(`  mode:      ${report.disposition}`));
    console.log(
      chalk.gray(
        `  items:     ${report.items.length}` +
          (report.dryRun === true
            ? ` (dry-run ${dry})`
            : ` (pending ${pending}, consumed ${consumed})`)
      )
    );
    for (const item of report.items) {
      const id = item.wakeId === null ? '' : chalk.gray(` id=${item.wakeId}`);
      console.log(
        `  [${item.disposition}] ${item.kind} ${item.target} signal=${item.signal}` +
          id
      );
    }
    console.log('');
    return report;
  }

  private requireDisposition(
    raw: string | undefined
  ): LegacyWakeMigrateDisposition {
    if (raw === undefined || raw.trim().length === 0) {
      return 'auto';
    }
    const value = raw.trim();
    if (value === 'auto' || value === 'pending' || value === 'consumed') {
      return value;
    }
    throw new WorkflowError(
      'daemon migrate-wake --disposition must be auto, pending, or consumed',
      'DAEMON_WATCH_INVALID'
    );
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
