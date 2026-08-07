import { createHash, randomBytes } from 'crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  ftruncateSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rename,
  unlinkSync,
  writeSync
} from 'fs';
import { injectable } from 'inversify';
import path from 'path';
import { deriveDaemonRuntimePaths } from './daemon-config.repository';
import {
  DurableWatchRecord,
  WakeActionFailure,
  WakeEvent,
  WakeEventInput
} from '../types';
import { writeFileAtomic } from '../utils/atomic-write';
import { wakeEventId } from '../utils/wake-event-id';

export type {
  DurableWatchRecord,
  WakeActionFailure,
  WakeEvent,
  WakeEventInput
};
export { wakeEventId };

/**
 * Outcome of {@link IDaemonStoreRepository.writeWake}. `created` is false when
 * the wake was already published by an earlier call — including one from an
 * earlier process, and including a wake that has since been consumed — so a
 * caller can tell a genuinely new signal from a re-detection of an old one.
 */
export interface WakeWriteResult {
  record: WakeEvent;
  created: boolean;
}

export interface PollLease {
  watchId: string;
  token: string;
  /**
   * Monotonic sequence number of this lease for its watch. It is part of the
   * lease's filename, which is what makes acquisition a compare-and-swap
   * rather than a check-then-write.
   */
  generation: number;
  acquiredAt: string;
  expiresAt: string;
}

/** Absolute locations of every directory the store owns for one workspace. */
export interface DaemonStorePaths {
  /** Per-workspace state root, shared with daemon lifecycle: `.sdlc/daemon/`. */
  root: string;
  /** One JSON file per watch registration. */
  watches: string;
  /** Exclusive, expiring in-flight poll leases. */
  pollLeases: string;
  /** Parent of the three wake directories. */
  wake: string;
  /** Canonical wake ledger: written once per wake ID, never removed. */
  wakeRecords: string;
  /** Hard links to ledger entries that have not been claimed yet. */
  pendingWakes: string;
  /** Those same links, renamed here by the claim that won them. */
  consumedWakes: string;
}

export interface IDaemonStoreRepository {
  paths(workspaceRoot: string): DaemonStorePaths;
  writeWatch<T extends DurableWatchRecord>(workspaceRoot: string, record: T): T;
  readWatch<T extends DurableWatchRecord>(
    workspaceRoot: string,
    id: string
  ): T | null;
  listWatches<T extends DurableWatchRecord>(workspaceRoot: string): T[];
  tryAcquirePollLease(
    workspaceRoot: string,
    watchId: string,
    leaseMilliseconds: number
  ): PollLease | null;
  releasePollLease(workspaceRoot: string, lease: PollLease): void;
  writeWake(workspaceRoot: string, input: WakeEventInput): WakeWriteResult;
  readWake(workspaceRoot: string, id: string): WakeEvent | null;
  listPendingWakes(workspaceRoot: string): WakeEvent[];
  /** Wakes already claimed (status / audit). Missing store: empty array. */
  listConsumedWakes(workspaceRoot: string): WakeEvent[];
  claimWake(workspaceRoot: string, id: string): Promise<WakeEvent | null>;
  /**
   * Stamp `consumedBy` onto an already-claimed wake. Writes in place so the
   * ledger and consumed hard link stay the same inode.
   */
  recordWakeConsumed(
    workspaceRoot: string,
    id: string,
    consumedBy: string
  ): WakeEvent;
  /**
   * Append an action failure without clearing consumption. Notification /
   * headless failures are observability, never a reason to re-queue.
   */
  recordWakeActionFailure(
    workspaceRoot: string,
    id: string,
    failure: WakeActionFailure
  ): WakeEvent;
}

const JSON_SUFFIX = '.json';

const requireWorkspaceRoot = (workspaceRoot: string): string => {
  if (typeof workspaceRoot !== 'string' || workspaceRoot.trim().length === 0) {
    throw new TypeError('Daemon store requires a non-empty workspace root');
  }
  return path.resolve(workspaceRoot.trim());
};

/**
 * Watch IDs are caller-supplied vocabulary (`pr-review:owner/repo#42`), which
 * contains separators that are not legal in a filename. Hashing gives a flat,
 * collision-free, traversal-proof name without encoding rules to get wrong.
 */
const recordName = (id: string): string => {
  if (typeof id !== 'string' || id.length === 0) {
    throw new TypeError('Daemon store record ID must be non-empty');
  }
  return createHash('sha256').update(id).digest('hex');
};

const recordFile = (directory: string, id: string): string =>
  path.join(directory, `${recordName(id)}${JSON_SUFFIX}`);

/** Width of the generation field, zero-padded so filenames sort numerically. */
const LEASE_GENERATION_DIGITS = 12;
const MAX_LEASE_GENERATION = 10 ** LEASE_GENERATION_DIGITS - 1;

/**
 * `<sha256(watchId)>.<generation>.json`.
 *
 * The generation is in the *name*, not only the contents, so "take the lease
 * that follows the one I observed" is a single exclusive `link(2)` on a name
 * only one process can create.
 */
const leaseFile = (
  directory: string,
  watchId: string,
  generation: number
): string => {
  if (
    Number.isSafeInteger(generation) === false ||
    generation <= 0 ||
    generation > MAX_LEASE_GENERATION
  ) {
    throw new TypeError('Poll lease generation must be a positive integer');
  }
  const padded = String(generation).padStart(LEASE_GENERATION_DIGITS, '0');
  return path.join(directory, `${recordName(watchId)}.${padded}${JSON_SUFFIX}`);
};

/** Generations present on disk for one watch, highest first. */
const leaseGenerations = (directory: string, watchId: string): number[] => {
  const prefix = `${recordName(watchId)}.`;
  return readdirSync(directory)
    .filter(name => name.startsWith(prefix) && name.endsWith(JSON_SUFFIX))
    .map(name =>
      Number(name.slice(prefix.length, name.length - JSON_SUFFIX.length))
    )
    .filter(generation => Number.isSafeInteger(generation) && generation > 0)
    .sort((left, right) => right - left);
};

/**
 * Wake IDs are already digests, so they are used verbatim — but only after
 * proving they are digests. A caller that passes an arbitrary string would
 * otherwise be able to steer a read or a rename outside the wake directories.
 */
const wakeFile = (directory: string, id: string): string => {
  if (/^[a-f0-9]{64}$/.test(id) === false) {
    throw new TypeError('Daemon store wake ID must be a SHA-256 digest');
  }
  return path.join(directory, `${id}${JSON_SUFFIX}`);
};

const parseRecord = <T>(file: string): T =>
  JSON.parse(readFileSync(file, 'utf-8')) as T;

const listRecords = <T>(directory: string): T[] => {
  if (existsSync(directory) === false) {
    return [];
  }
  return readdirSync(directory)
    .filter(name => name.endsWith(JSON_SUFFIX))
    .sort()
    .map(name => parseRecord<T>(path.join(directory, name)));
};

const writeAll = (fd: number, contents: string): void => {
  const bytes = Buffer.from(contents, 'utf-8');
  let offset = 0;
  while (offset < bytes.length) {
    offset += writeSync(fd, bytes, offset);
  }
};

/**
 * Flush a directory's own metadata. Fsyncing a file makes its bytes durable;
 * it does not make the *name* durable, so without this a reboot can lose the
 * directory entry that points at a perfectly intact file.
 */
const syncDirectory = (directory: string): void => {
  const fd = openSync(directory, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
};

/**
 * Overwrite an existing file without replacing its inode, so every hard link
 * (ledger + consumed) observes the same updated bytes.
 */
const writeFileInPlace = (file: string, contents: string): void => {
  const bytes = Buffer.from(contents, 'utf-8');
  const fd = openSync(file, 'r+');
  try {
    writeAll(fd, contents);
    ftruncateSync(fd, bytes.length);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  syncDirectory(path.dirname(file));
};

const isErrorCode = (error: unknown, code: string): boolean =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  (error as { code?: unknown }).code === code;

/**
 * Publish a fully fsynced file, but only if `file` does not already exist.
 *
 * `link(2)` is atomic *and* fails with `EEXIST` rather than clobbering, which
 * is exactly the primitive an idempotency gate needs. `rename(2)` cannot be
 * used here: it silently replaces the destination, so two writers racing on
 * the same ID would both believe they created it.
 *
 * @returns true when this call published the file, false when it already existed.
 */
const writeFileExclusiveAtomic = (file: string, contents: string): boolean => {
  const temporary = `${file}.tmp.${process.pid}.${randomBytes(4).toString('hex')}`;
  let published = false;
  try {
    const fd = openSync(temporary, 'wx');
    try {
      writeAll(fd, contents);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      linkSync(temporary, file);
      published = true;
      syncDirectory(path.dirname(file));
    } catch (error) {
      if (isErrorCode(error, 'EEXIST') === false) {
        throw error;
      }
    }
    return published;
  } finally {
    try {
      unlinkSync(temporary);
    } catch {
      // A failed open created nothing; a successful publication is linked.
    }
  }
};

/**
 * Give an existing inode a second name, treating "the name is already there"
 * as success: the caller only cares about the end state.
 */
const linkIfAbsent = (existing: string, additional: string): void => {
  try {
    linkSync(existing, additional);
    syncDirectory(path.dirname(additional));
  } catch (error) {
    if (isErrorCode(error, 'EEXIST') === false) {
      throw error;
    }
  }
};

/**
 * Durable, per-workspace storage for daemon watch registrations and wake
 * events (SPEC-PRD-0020-P1 T-02).
 *
 * Every record is an ordinary JSON file under the workspace's own
 * `.sdlc/daemon/` state directory — the same root the daemon lifecycle already
 * derives from the absolute workspace path. Two workspaces therefore address
 * two physically distinct trees and can never observe each other's records,
 * and state survives a process kill or a reboot with no database, broker, or
 * live session to keep alive.
 *
 * Layout, all under {@link DaemonStoreRepository.paths}:
 *
 * ```text
 * watches/<sha256(watchId)>.json   one registration per file
 * poll-leases/<sha256(watchId)>.<generation>.json  in-flight poll lease
 * wake/records/<wakeId>.json       the wake ledger — written once, never removed
 * wake/pending/<wakeId>.json       hard link to the ledger entry: unclaimed
 * wake/consumed/<wakeId>.json      that same link, renamed by the winning claim
 * ```
 *
 * The `pending/` + `consumed/` pair is the pre-existing durable wake inbox
 * shape (`scripts/wake-inbox.sh`) absorbed into this store rather than
 * duplicated beside it, so there is one wake queue in the workspace, not two.
 *
 * @remarks
 * The ledger is what makes publication and consumption safe against each
 * other, and the ordering it imposes is the single invariant the rest of this
 * class depends on:
 *
 * 1. `records/<id>.json` is created exclusively (`link(2)`, so `EEXIST` is a
 *    real answer rather than a lost update) and is *never* deleted or renamed.
 *    It is therefore a permanent, atomic "has this wake ever been published"
 *    gate — unlike an `existsSync` probe of `consumed/`, which a concurrent
 *    claim can invalidate between the check and the write.
 * 2. `pending/<id>.json` is linked only by the call that won step 1, so it is
 *    created at most once in the lifetime of a wake ID.
 * 3. Consumption is a `rename(2)` of that single pending link into
 *    `consumed/`. Because the link can never be recreated, at most one rename
 *    can ever succeed — a re-detected signal cannot resurrect a pending file
 *    and buy a second claim, and the rename can never replace an existing
 *    consumed record.
 *
 * Failure modes worth knowing:
 *
 * - Content and directory entries are fsynced before publication is reported,
 *   so a durable record never points at unwritten bytes after power loss.
 * - If a process is killed between steps 1 and 2, the wake stays durably
 *   readable via {@link DaemonStoreRepository.readWake} but is not queued for
 *   consumption, and is deliberately not re-queued later: re-linking `pending/`
 *   after the fact is precisely the resurrection that step 2 exists to
 *   prevent. Losing the delivery of a wake that no consumer had yet seen is
 *   the cheaper failure than delivering a consumed wake twice.
 * - A leaked `*.tmp.*` file after a hard kill is inert; readers only ever open
 *   the canonical paths.
 */
@injectable()
export class DaemonStoreRepository implements IDaemonStoreRepository {
  /**
   * Resolve the directories this store owns for `workspaceRoot`. Pure — it
   * creates nothing, so it is safe to call to inspect a workspace that has
   * never run a daemon.
   *
   * @param workspaceRoot - Workspace path; resolved to an absolute path, which
   * is what makes two different roots address two different trees.
   * @throws TypeError when `workspaceRoot` is empty or not a string.
   */
  paths(workspaceRoot: string): DaemonStorePaths {
    const root = deriveDaemonRuntimePaths(
      requireWorkspaceRoot(workspaceRoot)
    ).stateDir;
    const wake = path.join(root, 'wake');
    return {
      root,
      watches: path.join(root, 'watches'),
      pollLeases: path.join(root, 'poll-leases'),
      wake,
      wakeRecords: path.join(wake, 'records'),
      pendingWakes: path.join(wake, 'pending'),
      consumedWakes: path.join(wake, 'consumed')
    };
  }

  /**
   * Persist a watch registration, creating the store directories on first use.
   *
   * Unlike a wake, a watch is mutable state: re-writing the same `record.id`
   * replaces the previous version through an atomic rename, so a reader sees
   * either the old record or the new one and never a spliced file.
   *
   * @returns the same `record`, for call-site chaining.
   * @throws TypeError when `record.id` is empty.
   */
  writeWatch<T extends DurableWatchRecord>(
    workspaceRoot: string,
    record: T
  ): T {
    const { watches } = this.paths(workspaceRoot);
    mkdirSync(watches, { recursive: true });
    writeFileAtomic(
      recordFile(watches, record.id),
      `${JSON.stringify(record, null, 2)}\n`
    );
    syncDirectory(watches);
    return record;
  }

  /**
   * Read one watch registration.
   *
   * @returns the stored record, or null when this workspace has no watch with
   * that ID — including when the store has never been written at all.
   */
  readWatch<T extends DurableWatchRecord>(
    workspaceRoot: string,
    id: string
  ): T | null {
    const file = recordFile(this.paths(workspaceRoot).watches, id);
    return existsSync(file) ? parseRecord<T>(file) : null;
  }

  /**
   * Read every watch registered for this workspace, ordered by filename so the
   * result is stable across calls and machines. Non-JSON entries (scratch
   * files from an interrupted write) are ignored. Missing store: empty array.
   */
  listWatches<T extends DurableWatchRecord>(workspaceRoot: string): T[] {
    return listRecords<T>(this.paths(workspaceRoot).watches);
  }

  /**
   * Acquire one expiring lease for a watch, or report that another holder has
   * it.
   *
   * @remarks
   * Acquisition is a compare-and-swap on the lease *filename*: the current
   * lease is the highest generation present for the watch, and taking the
   * lease means exclusively creating generation + 1 through the same
   * `link(2)` primitive as wake records. Because a name can be created once,
   * two overlapping ticks that both observe generation `g` cannot both create
   * `g + 1` — exactly one wins and the loser is told the lease is held.
   *
   * This is what makes recovery from an abandoned lease safe. Reclaiming an
   * expired lease *adds* a generation instead of removing the expired file,
   * so no code path ever unlinks a lease it does not own, and a lease
   * acquired between another caller's expiry check and its own next syscall
   * cannot be destroyed by it. Superseded generations are pruned afterwards
   * purely to keep the directory small; they are already invisible to every
   * reader, which selects the highest generation.
   *
   * @returns the acquired lease, or null when a live lease is held or a
   * concurrent caller won the same generation.
   * @throws TypeError when `leaseMilliseconds` is not a positive integer.
   */
  tryAcquirePollLease(
    workspaceRoot: string,
    watchId: string,
    leaseMilliseconds: number
  ): PollLease | null {
    if (
      Number.isSafeInteger(leaseMilliseconds) === false ||
      leaseMilliseconds <= 0
    ) {
      throw new TypeError('Poll lease duration must be a positive integer');
    }
    const directory = this.paths(workspaceRoot).pollLeases;
    mkdirSync(directory, { recursive: true });

    // One retry covers the benign case where the observed generation is
    // pruned by its own successor's cleanup between the scan and the read.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const current = leaseGenerations(directory, watchId)[0] ?? 0;
      if (current > 0) {
        let held: PollLease;
        try {
          held = parseRecord<PollLease>(leaseFile(directory, watchId, current));
        } catch (error) {
          if (isErrorCode(error, 'ENOENT') === true) {
            continue;
          }
          throw error;
        }
        if (Date.parse(held.expiresAt) > Date.now()) {
          return null;
        }
      }
      if (current >= MAX_LEASE_GENERATION) {
        throw new Error(
          `Poll lease generations for ${watchId} are exhausted; remove ${directory}`
        );
      }
      const lease = this.publishLease(
        directory,
        watchId,
        current + 1,
        leaseMilliseconds
      );
      if (lease === null) {
        // Someone else created this generation: they are the holder now.
        return null;
      }
      this.pruneLeases(directory, watchId, lease.generation);
      return lease;
    }
    return null;
  }

  /**
   * Release only the exact lease that was acquired — its own generation *and*
   * its own token.
   *
   * @remarks
   * A late completion whose lease already expired therefore cannot remove the
   * successor lease that replaced it: the successor lives under a different
   * generation filename, and even a resurrected generation number carries a
   * different token. Releasing an already-released lease is a no-op.
   */
  releasePollLease(workspaceRoot: string, lease: PollLease): void {
    const directory = this.paths(workspaceRoot).pollLeases;
    const file = leaseFile(directory, lease.watchId, lease.generation);
    let current: PollLease;
    try {
      current = parseRecord<PollLease>(file);
    } catch (error) {
      if (isErrorCode(error, 'ENOENT') === true) {
        return;
      }
      throw error;
    }
    if (current.token !== lease.token) {
      return;
    }
    try {
      unlinkSync(file);
      syncDirectory(directory);
    } catch (error) {
      if (isErrorCode(error, 'ENOENT') === false) {
        throw error;
      }
    }
  }

  /** Exclusively create one generation of a watch's lease. */
  private publishLease(
    directory: string,
    watchId: string,
    generation: number,
    leaseMilliseconds: number
  ): PollLease | null {
    const acquiredAt = new Date().toISOString();
    const lease: PollLease = {
      watchId,
      token: randomBytes(16).toString('hex'),
      generation,
      acquiredAt,
      expiresAt: new Date(
        Date.parse(acquiredAt) + leaseMilliseconds
      ).toISOString()
    };
    return writeFileExclusiveAtomic(
      leaseFile(directory, watchId, generation),
      `${JSON.stringify(lease, null, 2)}\n`
    )
      ? lease
      : null;
  }

  /**
   * Drop generations below `generation`, which no reader can select any more.
   *
   * Housekeeping only: a failure here leaves inert files behind, so it must
   * never fail an acquisition that already succeeded.
   */
  private pruneLeases(
    directory: string,
    watchId: string,
    generation: number
  ): void {
    for (const stale of leaseGenerations(directory, watchId)) {
      if (stale >= generation) {
        continue;
      }
      try {
        unlinkSync(leaseFile(directory, watchId, stale));
      } catch {
        // Already gone, or not ours to remove.
      }
    }
    try {
      syncDirectory(directory);
    } catch {
      // Pruning is best effort; the lease itself is already durable.
    }
  }

  /**
   * Publish a wake event exactly once per `(kind, target, signal)` tuple.
   *
   * The tuple is hashed into the wake ID (see {@link wakeEventId}), so a
   * watcher that re-detects the same signal on every poll converges on one
   * record instead of burying the consumer under duplicates. Idempotency holds
   * for the whole life of the ID, not just while the wake is pending: once the
   * ledger entry exists, a later call returns the *original* record — with its
   * original timestamp and prompt — and creates nothing, whether or not the
   * wake has since been consumed.
   *
   * That is enforced by the ledger ordering described on this class: the
   * ledger entry is the atomic gate, and only the call that wins it links the
   * wake into `pending/`. A re-detected signal can therefore never restore a
   * pending file for a wake that has already been claimed.
   *
   * @returns the durable record plus whether this call is the one that
   * created it.
   */
  writeWake(workspaceRoot: string, input: WakeEventInput): WakeWriteResult {
    const paths = this.paths(workspaceRoot);
    mkdirSync(paths.wakeRecords, { recursive: true });
    mkdirSync(paths.pendingWakes, { recursive: true });
    mkdirSync(paths.consumedWakes, { recursive: true });

    const record: WakeEvent = { id: wakeEventId(input), ...input };
    const ledgerFile = wakeFile(paths.wakeRecords, record.id);
    const created = writeFileExclusiveAtomic(
      ledgerFile,
      `${JSON.stringify(record, null, 2)}\n`
    );
    if (created === false) {
      return { record: parseRecord<WakeEvent>(ledgerFile), created: false };
    }

    linkIfAbsent(ledgerFile, wakeFile(paths.pendingWakes, record.id));
    return { record, created: true };
  }

  /**
   * Read a wake by ID from the ledger, which answers for every wake that was
   * ever published regardless of whether it is still pending — a consumer that
   * claimed a wake can still read it back, and so can an auditor.
   *
   * @returns the stored record, or null when the ID was never published here.
   * @throws TypeError when `id` is not a SHA-256 digest.
   */
  readWake(workspaceRoot: string, id: string): WakeEvent | null {
    const ledgerFile = wakeFile(this.paths(workspaceRoot).wakeRecords, id);
    return existsSync(ledgerFile) ? parseRecord<WakeEvent>(ledgerFile) : null;
  }

  /**
   * List the wakes that are published but not yet claimed, ordered by wake ID
   * for a stable result. Missing store: empty array.
   */
  listPendingWakes(workspaceRoot: string): WakeEvent[] {
    return listRecords<WakeEvent>(this.paths(workspaceRoot).pendingWakes);
  }

  /**
   * List wakes that have already been claimed, ordered by wake ID for a
   * stable result. Missing store: empty array.
   */
  listConsumedWakes(workspaceRoot: string): WakeEvent[] {
    return listRecords<WakeEvent>(this.paths(workspaceRoot).consumedWakes);
  }

  /**
   * Claim a pending wake for consumption, at most once in the lifetime of the
   * wake ID.
   *
   * The claim is a single `rename(2)` of the pending link into `consumed/`.
   * `rename(2)` is atomic within a filesystem, so of any number of concurrent
   * claimants exactly one moves the entry and the rest find the source gone;
   * and because {@link DaemonStoreRepository.writeWake} links `pending/` at
   * most once ever, "the rest" includes every future claimant too.
   *
   * @returns the claimed record for the single winner, or null when there is
   * nothing to claim — never published, already claimed, or lost to a kill
   * between ledger publication and pending linkage.
   * @throws when the rename fails for any reason other than a missing source
   * (a full or read-only filesystem, say). The pending wake is left intact in
   * that case, so a later claim can still take it.
   */
  async claimWake(
    workspaceRoot: string,
    id: string
  ): Promise<WakeEvent | null> {
    const paths = this.paths(workspaceRoot);
    mkdirSync(paths.consumedWakes, { recursive: true });
    const pendingFile = wakeFile(paths.pendingWakes, id);
    const consumedFile = wakeFile(paths.consumedWakes, id);

    // Defence in depth, not the exactly-once mechanism: the ledger already
    // guarantees no pending link exists once this file does, so this check
    // cannot be raced into a wrong answer. It only downgrades an out-of-band
    // tampering (a hand-copied pending file) from a clobbered consumed record
    // to a no-op.
    if (existsSync(consumedFile)) {
      return null;
    }

    return new Promise<WakeEvent | null>((resolve, reject) => {
      rename(pendingFile, consumedFile, error => {
        if (error === null) {
          try {
            syncDirectory(paths.pendingWakes);
            syncDirectory(paths.consumedWakes);
            resolve(parseRecord<WakeEvent>(consumedFile));
          } catch (syncError) {
            reject(syncError);
          }
          return;
        }
        if (error.code === 'ENOENT') {
          resolve(null);
          return;
        }
        reject(error);
      });
    });
  }

  /**
   * Record which consumer won the claim. Must be called only after a
   * successful {@link claimWake}: the wake is already in `consumed/`, and this
   * stamps `consumedBy` onto the shared ledger inode.
   *
   * @throws when the wake was never published, or `consumedBy` is empty.
   */
  recordWakeConsumed(
    workspaceRoot: string,
    id: string,
    consumedBy: string
  ): WakeEvent {
    if (typeof consumedBy !== 'string' || consumedBy.trim().length === 0) {
      throw new TypeError('Wake consumedBy must be a non-empty string');
    }
    const ledgerFile = wakeFile(this.paths(workspaceRoot).wakeRecords, id);
    if (existsSync(ledgerFile) === false) {
      throw new Error(`Cannot record consumption for unknown wake ${id}`);
    }
    const current = parseRecord<WakeEvent>(ledgerFile);
    const updated: WakeEvent = {
      ...current,
      consumedBy: consumedBy.trim()
    };
    writeFileInPlace(ledgerFile, `${JSON.stringify(updated, null, 2)}\n`);
    return updated;
  }

  /**
   * Append a follow-up action failure onto a consumed wake. Does not move the
   * wake back to pending and does not clear `consumedBy`.
   *
   * @throws when the wake was never published.
   */
  recordWakeActionFailure(
    workspaceRoot: string,
    id: string,
    failure: WakeActionFailure
  ): WakeEvent {
    if (
      typeof failure.actionId !== 'string' ||
      failure.actionId.trim().length === 0
    ) {
      throw new TypeError('Wake action failure requires a non-empty actionId');
    }
    if (
      typeof failure.error !== 'string' ||
      failure.error.trim().length === 0
    ) {
      throw new TypeError('Wake action failure requires a non-empty error');
    }
    const ledgerFile = wakeFile(this.paths(workspaceRoot).wakeRecords, id);
    if (existsSync(ledgerFile) === false) {
      throw new Error(`Cannot record action failure for unknown wake ${id}`);
    }
    const current = parseRecord<WakeEvent>(ledgerFile);
    const entry: WakeActionFailure = {
      actionId: failure.actionId.trim(),
      at:
        typeof failure.at === 'string' && failure.at.length > 0
          ? failure.at
          : new Date().toISOString(),
      error: failure.error.trim(),
      ...(failure.channelId !== undefined && failure.channelId.trim().length > 0
        ? { channelId: failure.channelId.trim() }
        : {})
    };
    const updated: WakeEvent = {
      ...current,
      actionFailures: [...(current.actionFailures ?? []), entry]
    };
    writeFileInPlace(ledgerFile, `${JSON.stringify(updated, null, 2)}\n`);
    return updated;
  }
}
