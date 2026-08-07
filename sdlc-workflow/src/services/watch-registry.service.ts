import { inject, injectable } from 'inversify';
import type { IDaemonStoreRepository } from '../repositories/daemon-store.repository';
import { WORKFLOW_TOKENS } from '../tokens';
import type {
  ActiveWatch,
  DurableWatchRecord,
  WatchKind,
  WatchRegistrationInput,
  WatchTarget
} from '../types';

export interface WatchPollResult {
  /** Set when the source reports a terminal target state, such as merged. */
  terminalState?: string;
}

/**
 * Durable watch lifecycle contract shared by the CLI and the poll loop.
 *
 * @remarks
 * Every method is scoped by `workspaceRoot`: an id or target registered under
 * one workspace is invisible to calls made with another. No method accepts or
 * retains a chat/session object, so registrations outlive the process that
 * created them.
 *
 * "Active" means a record with no `expiredAt` and no elapsed `expiresAt`.
 * Expired records stay on disk for audit but are omitted from every query
 * below.
 */
export interface IWatchRegistryService {
  /**
   * Register (or return the existing) watch for `kind` + `target`.
   *
   * @remarks
   * Identity is `kind` plus the canonical target (see {@link normalizeTarget}),
   * so the same logical target always maps to one durable record. On an
   * already-active record this is a no-op read: the first write is returned
   * verbatim and later `pollSeconds` / `action` / `expiresAt` / `createdBy`
   * values are **ignored** rather than merged. Re-registering an expired id
   * replaces it with a fresh active record.
   *
   * @throws TypeError when the target does not carry exactly the identifying
   * fields its kind requires, or when a lifecycle field is malformed.
   */
  register(
    workspaceRoot: string,
    input: WatchRegistrationInput
  ): DurableWatchRecord;
  /**
   * Load one active watch by durable id, or `null`.
   *
   * @remarks
   * Read path with a write side effect: a record whose declared `expiresAt`
   * has elapsed is durably stamped with `expiredAt` before being reported as
   * absent, so expiry survives without a sweeper.
   */
  get(workspaceRoot: string, id: string): DurableWatchRecord | null;
  /**
   * Resolve an active watch by `kind` + `target` instead of by id.
   *
   * @remarks
   * Same identity derivation and same lazy-expiry side effect as
   * {@link IWatchRegistryService.get}.
   */
  getByTarget(
    workspaceRoot: string,
    kind: WatchKind,
    target: WatchTarget
  ): DurableWatchRecord | null;
  /**
   * List active watches oldest-first, projected for status surfaces.
   *
   * @remarks
   * Adds `age` (whole seconds since `createdAt`) and `lastPollTime` (`null`
   * until first poll). Applies the same lazy `expiredAt` persistence as
   * {@link IWatchRegistryService.get} to every row it reads.
   */
  list(workspaceRoot: string): ActiveWatch[];
  /**
   * Stamp `lastPollTime`, and expire the watch on a terminal target state.
   *
   * @remarks
   * A `result.terminalState` (for example `merged`) durably records
   * `terminalState` and `expiredAt`, which is how a finished target stops
   * being polled instead of being polled forever. Returns `null` for an id
   * that is missing or no longer active, so a caller cannot poll an expired
   * watch back to life.
   */
  recordPoll(
    workspaceRoot: string,
    id: string,
    result?: WatchPollResult
  ): DurableWatchRecord | null;
  /**
   * Persist one failed adapter attempt and degrade at `failureCap`.
   *
   * Degraded watches remain active and visible to status, but poll schedulers
   * must skip them until a later phase supplies an explicit recovery path.
   */
  recordPollFailure(
    workspaceRoot: string,
    id: string,
    error: unknown,
    failureCap: number
  ): DurableWatchRecord | null;
  /**
   * Expire an active watch now, labelled with `terminalState`.
   *
   * @remarks
   * The record is kept on disk with `expiredAt` set and omitted from all
   * later active queries. Returns `null` when the id is missing or already
   * inactive, making repeat calls harmless.
   */
  expire(
    workspaceRoot: string,
    id: string,
    terminalState: string
  ): DurableWatchRecord | null;
}

const requireText = (value: string, field: string): string => {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`Watch registration ${field} must be non-empty`);
  }
  return value.trim();
};

const validateDate = (value: string | undefined, field: string): void => {
  if (value !== undefined && Number.isNaN(Date.parse(value))) {
    throw new TypeError(`Watch registration ${field} must be an ISO timestamp`);
  }
};

type TargetField = keyof WatchTarget;

/**
 * The exact identifying fields each kind's target must carry.
 *
 * @remarks
 * Typed as a total `Record<WatchKind, …>` on purpose: adding a watch kind
 * without deciding what identifies its target is a compile error, never a
 * silent fallback. Field order here is also the canonical key order used to
 * serialize the identity, so a target is order-independent for callers.
 *
 * Every field listed is required and every field not listed is rejected —
 * identity may not depend on an optional field, otherwise the same target
 * registered with and without it would yield two records for one thing.
 */
const WATCH_TARGET_IDENTITY = {
  /** A pull request: its number is only unique within a repository. */
  'pr-review': ['repo', 'number'],
  'pr-checks': ['repo', 'number'],
  /** An issue: same repository-scoped numbering as a pull request. */
  'issue-state': ['repo', 'number'],
  /** A GitHub Actions run: its id is scoped to the repository that ran it. */
  'workflow-run': ['repo', 'runId'],
  /** An engine run: the run id is workspace-unique on its own. */
  'run-supervisor': ['runId'],
  /** A queued launch record, keyed by the run id it will start. */
  'queue-item': ['runId']
} as const satisfies Record<WatchKind, readonly TargetField[]>;

/** GitHub `owner/name`; case-insensitive, so identity lowercases it. */
const REPO_PATTERN = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

const joinFields = (fields: readonly string[]): string =>
  fields.length < 2
    ? (fields[0] ?? '')
    : `${fields.slice(0, -1).join(', ')} and ${fields[fields.length - 1]}`;

const normalizeRepo = (value: string): string => {
  const repo = requireText(value, 'target.repo');
  if (REPO_PATTERN.test(repo) === false) {
    throw new TypeError(
      'Watch registration target.repo must be owner/name, so two owners with ' +
        'a same-named repository cannot share one watch id'
    );
  }
  return repo.toLowerCase();
};

const normalizeNumber = (value: number): number => {
  if (Number.isSafeInteger(value) === false || value <= 0) {
    throw new TypeError(
      'Watch registration target.number must be a positive integer'
    );
  }
  return value;
};

/**
 * Canonical target for durable identity, validated against `kind`.
 *
 * @remarks
 * Returns a new object holding exactly the fields
 * {@link WATCH_TARGET_IDENTITY} requires for `kind`, in that order, with
 * `repo` lowercased and text trimmed. Because the field set is exact, two
 * registrations produce the same id only when they name the same target:
 * `{ number: 42 }` is rejected rather than collapsing every repository's PR
 * 42 onto one record, and an extra field (say `runId` on a `pr-review`) is
 * rejected rather than being dropped from the id it does not belong in.
 *
 * @throws TypeError for an unknown kind, a missing identifying field, a field
 * the kind does not accept, or a malformed value.
 */
export const normalizeTarget = (
  kind: WatchKind,
  target: WatchTarget
): WatchTarget => {
  if (typeof target !== 'object' || target === null) {
    throw new TypeError('Watch registration target must be an object');
  }
  const required: readonly TargetField[] | undefined =
    WATCH_TARGET_IDENTITY[kind];
  if (required === undefined) {
    throw new TypeError(`Watch registration kind ${String(kind)} is unknown`);
  }

  const unexpected = (Object.keys(target) as TargetField[]).filter(
    field => target[field] !== undefined && required.includes(field) === false
  );
  if (unexpected.length > 0) {
    throw new TypeError(
      `Watch registration target for ${kind} does not accept ` +
        `${joinFields(unexpected)}; it is identified by ${joinFields(required)}`
    );
  }
  const missing = required.filter(field => target[field] === undefined);
  if (missing.length > 0) {
    throw new TypeError(
      `Watch registration target for ${kind} requires ` +
        `${joinFields(required)} (missing: ${joinFields(missing)})`
    );
  }

  const normalized: WatchTarget = {};
  for (const field of required) {
    if (field === 'repo') {
      normalized.repo = normalizeRepo(target.repo as string);
    } else if (field === 'number') {
      normalized.number = normalizeNumber(target.number as number);
    } else {
      normalized.runId = requireText(target.runId as string, 'target.runId');
    }
  }
  return normalized;
};

/**
 * Stable identity required by PRD-0020 §4: `kind` plus its canonical target.
 *
 * @remarks
 * Derived only from {@link normalizeTarget} output, so callers may pass target
 * fields in any order or letter case for `repo` and still address the same
 * durable record.
 */
export const watchRegistrationId = (
  kind: WatchKind,
  target: WatchTarget
): string => `${kind}:${JSON.stringify(normalizeTarget(kind, target))}`;

/**
 * Durable, workspace-scoped lifecycle API shared by CLI and poll-loop callers.
 *
 * The service stores values only through the workspace-derived daemon store;
 * it has no session or chat references, so a fresh process sees identical
 * registrations. Expired records remain durable for audit but are omitted
 * from normal query and list results.
 */
@injectable()
export class WatchRegistryService implements IWatchRegistryService {
  constructor(
    @inject(WORKFLOW_TOKENS.DaemonStoreRepository)
    private readonly _store: IDaemonStoreRepository
  ) {}

  /**
   * Persist a watch for `kind` + `target` in the workspace store.
   *
   * @remarks
   * Validates the whole input before touching disk, so a rejected
   * registration leaves no partial record. The stored `target` is the
   * canonical form from {@link normalizeTarget}, not the caller's object.
   *
   * Idempotent on an already-active record: returns the first write and
   * ignores later field changes (`pollSeconds`, `action`, `expiresAt`,
   * `createdBy`) — a caller that needs different cadence or action must
   * {@link WatchRegistryService.expire} the watch and register again. A
   * previously expired id may be re-registered as a new active record with a
   * fresh `createdAt`.
   */
  register(
    workspaceRoot: string,
    input: WatchRegistrationInput
  ): DurableWatchRecord {
    this.validateInput(input);
    const target = normalizeTarget(input.kind, input.target);
    const id = watchRegistrationId(input.kind, target);
    const existing = this._store.readWatch<DurableWatchRecord>(
      workspaceRoot,
      id
    );
    const now = new Date().toISOString();

    if (existing !== null && this.isActive(existing, now)) {
      return existing;
    }

    const record: DurableWatchRecord = {
      id,
      kind: input.kind,
      target,
      pollSeconds: input.pollSeconds,
      createdBy: input.createdBy.trim(),
      createdAt: now
    };
    if (input.action !== undefined) {
      record.action = input.action;
    }
    if (input.expiresAt !== undefined) {
      record.expiresAt = input.expiresAt;
    }
    return this._store.writeWatch(workspaceRoot, record);
  }

  /**
   * Load one watch by durable id.
   *
   * @remarks
   * Soft-expired rows (`expiresAt` ≤ now without `expiredAt`) are persisted
   * with `expiredAt` on this read path, then omitted from the return value.
   * Already-expired rows return `null` without rewriting.
   */
  get(workspaceRoot: string, id: string): DurableWatchRecord | null {
    const record = this._store.readWatch<DurableWatchRecord>(workspaceRoot, id);
    if (record === null) {
      return null;
    }
    return this.activeRecord(workspaceRoot, record, new Date().toISOString());
  }

  /**
   * Resolve a watch by kind+target identity (same id scheme as
   * {@link WatchRegistryService.register}).
   *
   * @remarks
   * Delegates to {@link WatchRegistryService.get}, so it inherits the lazy
   * `expiredAt` write and returns `null` for an expired target. Rejects a
   * target that is not valid for `kind` rather than reporting "not found".
   */
  getByTarget(
    workspaceRoot: string,
    kind: WatchKind,
    target: WatchTarget
  ): DurableWatchRecord | null {
    return this.get(workspaceRoot, watchRegistrationId(kind, target));
  }

  /**
   * Active watches only, oldest `createdAt` first, with `age` /
   * `lastPollTime` projections.
   *
   * @remarks
   * Applies the same lazy `expiredAt` persistence as
   * {@link WatchRegistryService.get} to every row it reads, so listing is what
   * retires watches that passed their declared expiry with no poll. `age` is
   * whole seconds since `createdAt` (never negative) and `lastPollTime` is
   * `null` rather than absent until the first poll.
   */
  list(workspaceRoot: string): ActiveWatch[] {
    const now = new Date().toISOString();
    const nowMilliseconds = Date.parse(now);
    return this._store
      .listWatches<DurableWatchRecord>(workspaceRoot)
      .map(record => this.activeRecord(workspaceRoot, record, now))
      .filter((record): record is DurableWatchRecord => record !== null)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map(record => ({
        id: record.id,
        kind: record.kind,
        target: record.target,
        pollSeconds: record.pollSeconds,
        ...(record.action === undefined ? {} : { action: record.action }),
        createdBy: record.createdBy,
        ...(record.expiresAt === undefined
          ? {}
          : { expiresAt: record.expiresAt }),
        age: Math.max(
          0,
          Math.floor((nowMilliseconds - Date.parse(record.createdAt)) / 1_000)
        ),
        lastPollTime: record.lastPollTime ?? null,
        consecutiveFailures: record.consecutiveFailures ?? 0,
        lastError: record.lastError ?? null,
        degradedAt: record.degradedAt ?? null
      }));
  }

  /**
   * Stamp `lastPollTime`; optionally mark terminal and expire.
   *
   * @remarks
   * When `result.terminalState` is set (a merged or closed PR, say), the same
   * write records `terminalState` and `expiredAt`, so subsequent
   * {@link WatchRegistryService.get} and {@link WatchRegistryService.list}
   * calls omit the watch and the poll loop stops visiting a finished target.
   * The record itself is retained on disk for audit. Returns `null` if the id
   * is missing or already inactive — polling cannot revive an expired watch.
   */
  recordPoll(
    workspaceRoot: string,
    id: string,
    result: WatchPollResult = {}
  ): DurableWatchRecord | null {
    const record = this.get(workspaceRoot, id);
    if (record === null) {
      return null;
    }
    const now = new Date().toISOString();
    const {
      consecutiveFailures: _consecutiveFailures,
      lastError: _lastError,
      degradedAt: _degradedAt,
      ...healthy
    } = record;
    const updated: DurableWatchRecord = { ...healthy, lastPollTime: now };
    if (result.terminalState !== undefined) {
      updated.terminalState = requireText(
        result.terminalState,
        'terminalState'
      );
      updated.expiredAt = now;
    }
    return this._store.writeWatch(workspaceRoot, updated);
  }

  recordPollFailure(
    workspaceRoot: string,
    id: string,
    error: unknown,
    failureCap: number
  ): DurableWatchRecord | null {
    if (Number.isSafeInteger(failureCap) === false || failureCap <= 0) {
      throw new TypeError('Watch poll failure cap must be a positive integer');
    }
    const record = this.get(workspaceRoot, id);
    if (record === null || record.degradedAt !== undefined) {
      return record;
    }
    const now = new Date().toISOString();
    const consecutiveFailures = (record.consecutiveFailures ?? 0) + 1;
    const updated: DurableWatchRecord = {
      ...record,
      lastPollTime: now,
      consecutiveFailures,
      lastError: error instanceof Error ? error.message : String(error)
    };
    if (consecutiveFailures >= failureCap) {
      updated.degradedAt = now;
    }
    return this._store.writeWatch(workspaceRoot, updated);
  }

  /**
   * Force-expire an active watch with a terminal-state label.
   *
   * @remarks
   * Persists `terminalState` and `expiredAt` immediately; the row stays on
   * disk for audit but every later active query omits it, and
   * {@link WatchRegistryService.register} treats the id as free again.
   * Returns `null` when the id is missing or already inactive, so a repeated
   * expire is a no-op instead of rewriting the original expiry time.
   */
  expire(
    workspaceRoot: string,
    id: string,
    terminalState: string
  ): DurableWatchRecord | null {
    const record = this.get(workspaceRoot, id);
    if (record === null) {
      return null;
    }
    const expired: DurableWatchRecord = {
      ...record,
      terminalState: requireText(terminalState, 'terminalState'),
      expiredAt: new Date().toISOString()
    };
    return this._store.writeWatch(workspaceRoot, expired);
  }

  /**
   * Active record, or `null` after durably retiring a lapsed declared expiry.
   *
   * @remarks
   * The single read path behind every query: it converts the soft signal
   * (`expiresAt` in the past) into the durable one (`expiredAt`) exactly once,
   * which is why no periodic sweeper is required for expiry to stick.
   */
  private activeRecord(
    workspaceRoot: string,
    record: DurableWatchRecord,
    now: string
  ): DurableWatchRecord | null {
    if (this.isActive(record, now)) {
      return record;
    }
    if (
      record.expiredAt === undefined &&
      record.expiresAt !== undefined &&
      Date.parse(record.expiresAt) <= Date.parse(now)
    ) {
      this._store.writeWatch(workspaceRoot, { ...record, expiredAt: now });
    }
    return null;
  }

  private isActive(record: DurableWatchRecord, now: string): boolean {
    if (record.expiredAt !== undefined) {
      return false;
    }
    return (
      record.expiresAt === undefined ||
      Date.parse(record.expiresAt) > Date.parse(now)
    );
  }

  private validateInput(input: WatchRegistrationInput): void {
    if (Number.isSafeInteger(input.pollSeconds) === false) {
      throw new TypeError(
        'Watch registration pollSeconds must be a positive integer'
      );
    }
    if (input.pollSeconds <= 0) {
      throw new TypeError(
        'Watch registration pollSeconds must be a positive integer'
      );
    }
    requireText(input.createdBy, 'createdBy');
    normalizeTarget(input.kind, input.target);
    validateDate(input.expiresAt, 'expiresAt');
    if (input.action !== undefined) {
      requireText(input.action.transcriptDir, 'action.transcriptDir');
    }
  }
}
