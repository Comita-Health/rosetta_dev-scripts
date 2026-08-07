import { inject, injectable } from 'inversify';
import type { IDaemonConfigRepository } from '../repositories/daemon-config.repository';
import type { IDaemonStoreRepository } from '../repositories/daemon-store.repository';
import type { IKnownWatchTargetRepository } from '../repositories/known-watch-target.repository';
import { WORKFLOW_TOKENS } from '../tokens';
import type {
  DaemonStatusReport,
  DaemonStatusUnwatched,
  DaemonStatusWake,
  DaemonStatusWatch,
  WakeEvent,
  WatchTarget
} from '../types';
import {
  watchRegistrationId,
  type IWatchRegistryService
} from './watch-registry.service';

/**
 * Assembles the operator-facing daemon status report from the watch
 * registry, wake inbox, and engine-discovered known targets
 * (SPEC-PRD-0020-P1 T-07).
 */
export interface IDaemonStatusService {
  /**
   * Build a status report for `workspaceRoot`.
   *
   * @throws {WorkflowError} `DAEMON_CONFIG_INVALID` when the workspace root
   *   or `.sdlc/daemon.json` is unusable (needed for `runsDir` discovery).
   */
  build(workspaceRoot: string): DaemonStatusReport;
}

const formatTarget = (target: WatchTarget): string => {
  if (target.repo !== undefined && target.number !== undefined) {
    return `${target.repo}#${target.number}`;
  }
  if (target.runId !== undefined) {
    return target.runId;
  }
  return JSON.stringify(target);
};

/** Human-readable target column for the status table. */
export const formatWatchTarget = formatTarget;

@injectable()
export class DaemonStatusService implements IDaemonStatusService {
  constructor(
    @inject(WORKFLOW_TOKENS.DaemonConfigRepository)
    private readonly _configRepo: IDaemonConfigRepository,
    @inject(WORKFLOW_TOKENS.WatchRegistryService)
    private readonly _registry: IWatchRegistryService,
    @inject(WORKFLOW_TOKENS.DaemonStoreRepository)
    private readonly _store: IDaemonStoreRepository,
    @inject(WORKFLOW_TOKENS.KnownWatchTargetRepository)
    private readonly _knownTargets: IKnownWatchTargetRepository
  ) {}

  build(workspaceRoot: string): DaemonStatusReport {
    const { config } = this._configRepo.load(workspaceRoot);
    const absoluteRoot = config.workspaceRoot;
    const active = this._registry.list(absoluteRoot);
    const watches: DaemonStatusWatch[] = active.map(watch => ({
      id: watch.id,
      kind: watch.kind,
      target: watch.target,
      age: watch.age,
      lastPollTime: watch.lastPollTime,
      degraded: watch.degradedAt !== null,
      degradedAt: watch.degradedAt,
      consecutiveFailures: watch.consecutiveFailures,
      lastError: watch.lastError
    }));

    const pending = this._store.listPendingWakes(absoluteRoot);
    const consumed = this._store.listConsumedWakes(absoluteRoot);
    const wakes: DaemonStatusWake[] = [
      ...pending.map(wake => this.projectWake(wake, 'pending')),
      ...consumed.map(wake => this.projectWake(wake, 'consumed'))
    ].sort((left, right) => left.createdAt.localeCompare(right.createdAt));

    const activeIds = new Set(
      active.map(watch => watchRegistrationId(watch.kind, watch.target))
    );
    const unwatched: DaemonStatusUnwatched[] = this._knownTargets
      .list(config.runsDir)
      .filter(
        known =>
          activeIds.has(watchRegistrationId(known.kind, known.target)) === false
      );

    return {
      workspaceRoot: absoluteRoot,
      watches,
      wakes,
      unwatched
    };
  }

  private projectWake(
    wake: WakeEvent,
    state: 'pending' | 'consumed'
  ): DaemonStatusWake {
    return {
      id: wake.id,
      kind: wake.kind,
      target: wake.target,
      signal: wake.signal,
      createdAt: wake.createdAt,
      state,
      consumedBy: wake.consumedBy ?? null
    };
  }
}
