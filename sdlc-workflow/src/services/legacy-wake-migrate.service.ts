import { inject, injectable } from 'inversify';
import type { IDaemonStoreRepository } from '../repositories/daemon-store.repository';
import type {
  ILegacyWakeInboxRepository,
  LegacyWakeRecord
} from '../repositories/legacy-wake-inbox.repository';
import { WORKFLOW_TOKENS } from '../tokens';
import type { WakeEventInput } from '../types';

/** How newly written wakes are left for the daemon consumer. */
export type LegacyWakeMigrateDisposition = 'pending' | 'consumed' | 'auto';

export interface LegacyWakeMigrateOptions {
  /** Legacy wake root (`…/wake`). Defaults to `$ROSETTA_WAKE_DIR`. */
  fromWakeDir?: string;
  /**
   * `pending` — leave every migrated wake for the daemon to notify.
   * `consumed` — claim immediately as `legacy-migrate` (import-only).
   * `auto` — `pr_approve` → consumed (already acted on historically);
   *   escalations / supervisor exits → pending for notify drain.
   */
  disposition?: LegacyWakeMigrateDisposition;
  /** When true, map and report without writing or archiving. */
  dryRun?: boolean;
}

export interface LegacyWakeMigrateItemResult {
  sourceFile: string;
  kind: string;
  target: string;
  signal: string;
  wakeId: string | null;
  disposition: 'pending' | 'consumed' | 'skipped' | 'dry-run';
  created: boolean;
  detail?: string;
}

export interface LegacyWakeMigrateReport {
  fromWakeDir: string;
  workspaceRoot: string;
  dryRun: boolean;
  disposition: LegacyWakeMigrateDisposition;
  items: LegacyWakeMigrateItemResult[];
}

/**
 * Move stranded `~/.rosetta/wake/pending` files into the PRD-0020 daemon
 * wake ledger so the KeepAlive consumer can drain them.
 *
 * @remarks
 * Identity is still `(kind, target, signal)` via {@link IDaemonStoreRepository.writeWake}.
 * Legacy slug filenames are not preserved; `legacyDedupeKey` is kept on
 * `data` for audit. After a successful write the source file is renamed into
 * the legacy `consumed/` tree so a second migrate is a no-op scan.
 */
export interface ILegacyWakeMigrateService {
  migrate(
    workspaceRoot: string,
    options?: LegacyWakeMigrateOptions
  ): Promise<LegacyWakeMigrateReport>;
}

export const LEGACY_MIGRATE_CONSUMER_ID = 'legacy-migrate';

/**
 * Map a session-era wake record onto the daemon {@link WakeEventInput} shape.
 *
 * @remarks
 * `pr_approve` keeps `owner/repo#N` as target and `approved` /
 * `changes_requested` as signal. Escalations use `runId` + `trigger`.
 * Supervisor exits use `runId` + `reason` (fallback `exit`).
 */
export const mapLegacyWakeToInput = (
  legacy: LegacyWakeRecord
): WakeEventInput => {
  const data = legacy.data;
  let target = legacy.dedupeKey;
  let signal = 'legacy';

  if (legacy.kind === 'pr_approve') {
    if (typeof data.target === 'string' && data.target.trim().length > 0) {
      target = data.target.trim();
    } else if (
      typeof data.repo === 'string' &&
      typeof data.number === 'number' &&
      Number.isSafeInteger(data.number) &&
      data.number > 0
    ) {
      target = `${data.repo}#${data.number}`;
    }
    if (typeof data.signal === 'string' && data.signal.trim().length > 0) {
      signal = data.signal.trim();
    }
  } else if (legacy.kind === 'sdlc_escalation') {
    if (typeof data.runId === 'string' && data.runId.trim().length > 0) {
      target = data.runId.trim();
    }
    if (typeof data.trigger === 'string' && data.trigger.trim().length > 0) {
      signal = data.trigger.trim();
    }
  } else if (legacy.kind === 'sdlc_supervisor') {
    if (typeof data.runId === 'string' && data.runId.trim().length > 0) {
      target = data.runId.trim();
    }
    if (typeof data.reason === 'string' && data.reason.trim().length > 0) {
      signal = data.reason.trim();
    } else {
      signal = 'exit';
    }
  }

  return {
    kind: legacy.kind,
    target,
    signal,
    createdAt: legacy.createdAt,
    prompt: legacy.prompt,
    data: {
      ...data,
      legacyDedupeKey: legacy.dedupeKey,
      migratedFrom: 'rosetta-wake'
    }
  };
};

const resolveDisposition = (
  kind: string,
  mode: LegacyWakeMigrateDisposition
): 'pending' | 'consumed' => {
  if (mode === 'pending') {
    return 'pending';
  }
  if (mode === 'consumed') {
    return 'consumed';
  }
  // auto: historical PR approve wakes already drove a session; re-notifying
  // dozens of merged PRs is noise. Escalations still need a human.
  return kind === 'pr_approve' ? 'consumed' : 'pending';
};

@injectable()
export class LegacyWakeMigrateService implements ILegacyWakeMigrateService {
  constructor(
    @inject(WORKFLOW_TOKENS.DaemonStoreRepository)
    private readonly _store: IDaemonStoreRepository,
    @inject(WORKFLOW_TOKENS.LegacyWakeInboxRepository)
    private readonly _legacy: ILegacyWakeInboxRepository
  ) {}

  /**
   * Import every legacy pending wake into the workspace daemon store.
   *
   * @remarks
   * Idempotent on wake id: a prior migrate that already published the ledger
   * entry reports `created: false` and still archives the legacy file when
   * present. Does not require the daemon process to be running — writes go
   * straight to `.sdlc/daemon/wake/`.
   */
  async migrate(
    workspaceRoot: string,
    options: LegacyWakeMigrateOptions = {}
  ): Promise<LegacyWakeMigrateReport> {
    const disposition = options.disposition ?? 'auto';
    const dryRun = options.dryRun === true;
    const fromWakeDir = this._legacy.resolveRoot(options.fromWakeDir);
    const pending = this._legacy.listPending(options.fromWakeDir);
    const items: LegacyWakeMigrateItemResult[] = [];

    for (const legacy of pending) {
      const input = mapLegacyWakeToInput(legacy);
      const leaveAs = resolveDisposition(legacy.kind, disposition);

      if (dryRun === true) {
        items.push({
          sourceFile: legacy.filePath,
          kind: input.kind,
          target: input.target,
          signal: input.signal,
          wakeId: null,
          disposition: 'dry-run',
          created: false,
          detail: `would leave as ${leaveAs}`
        });
        continue;
      }

      const written = this._store.writeWake(workspaceRoot, input);
      let finalDisposition: 'pending' | 'consumed' = 'pending';

      if (leaveAs === 'consumed') {
        const claimed = await this._store.claimWake(
          workspaceRoot,
          written.record.id
        );
        if (claimed !== null) {
          this._store.recordWakeConsumed(
            workspaceRoot,
            claimed.id,
            LEGACY_MIGRATE_CONSUMER_ID
          );
          finalDisposition = 'consumed';
        } else if (written.record.consumedBy !== undefined) {
          finalDisposition = 'consumed';
        } else {
          // Already pending from a prior migrate that used disposition=pending;
          // leave it — operator can re-run with --disposition consumed.
          finalDisposition = 'pending';
        }
      }

      this._legacy.archivePending(legacy.filePath, options.fromWakeDir);
      items.push({
        sourceFile: legacy.filePath,
        kind: input.kind,
        target: input.target,
        signal: input.signal,
        wakeId: written.record.id,
        disposition: finalDisposition,
        created: written.created
      });
    }

    return {
      fromWakeDir,
      workspaceRoot,
      dryRun,
      disposition,
      items
    };
  }
}
