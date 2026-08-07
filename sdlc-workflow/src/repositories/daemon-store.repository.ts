import { createHash, randomBytes } from 'crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
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
import { DurableWatchRecord, WakeEvent, WakeEventInput } from '../types';
import { writeFileAtomic } from '../utils/atomic-write';
import { wakeEventId } from '../utils/wake-event-id';

export type { DurableWatchRecord, WakeEvent, WakeEventInput };
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

/** Absolute locations of every directory the store owns for one workspace. */
export interface DaemonStorePaths {
  /** Per-workspace state root, shared with daemon lifecycle: `.sdlc/daemon/`. */
  root: string;
  /** One JSON file per watch registration. */
  watches: string;
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
  writeWake(workspaceRoot: string, input: WakeEventInput): WakeWriteResult;
  readWake(workspaceRoot: string, id: string): WakeEvent | null;
  listPendingWakes(workspaceRoot: string): WakeEvent[];
  claimWake(workspaceRoot: string, id: string): Promise<WakeEvent | null>;
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
const recordFile = (directory: string, id: string): string => {
  if (typeof id !== 'string' || id.length === 0) {
    throw new TypeError('Daemon store record ID must be non-empty');
  }
  const filename = createHash('sha256').update(id).digest('hex');
  return path.join(directory, `${filename}${JSON_SUFFIX}`);
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
}
