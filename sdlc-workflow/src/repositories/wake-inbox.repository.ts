import { createHash } from 'crypto';
import { existsSync, mkdirSync, writeFileSync, renameSync } from 'fs';
import { injectable } from 'inversify';
import os from 'os';
import path from 'path';

/**
 * Durable agent wake inbox — TypeScript mirror of `scripts/wake-inbox.sh`.
 *
 * Writes `$ROSETTA_WAKE_DIR/pending/<slug>.json` (default
 * `~/.rosetta/wake/pending`) so an escalation (fail-loud T-04) or supervise
 * exit (#38 / fail-loud T-02) survives a dead terminal and is drained by the
 * Cursor stop hook.
 */
export interface WakeEmitInput {
  kind: string;
  dedupeKey: string;
  prompt: string;
  data?: Record<string, unknown>;
  /**
   * Distinguishes *this* occurrence of `(kind, dedupeKey)` from a mere
   * replay of it — typically the failing verdict's inputs digest or the
   * task head SHA. {@link IWakeInboxRepository.emitOnce} suppresses a
   * repeat only when the occurrence key also matches, so resuming a run
   * stays quiet while the *same* escalation against *new* content notifies
   * again. Omitted → the pre-Wave-0 behaviour of once-ever per dedupeKey.
   */
  occurrenceKey?: string;
  /** Override root for tests (`…/wake`); production leaves unset. */
  wakeDir?: string;
}

export interface IWakeInboxRepository {
  /** Write/overwrite the pending wake file for `(kind, dedupeKey)`. */
  emit(input: WakeEmitInput): string;
  /**
   * Emit at most once per `(kind, dedupeKey, occurrenceKey)`.
   *
   * @remarks
   * The pending file is still keyed by `(kind, dedupeKey)` alone, so a
   * recurrence overwrites rather than piling up N files for one problem —
   * only the *notified marker* carries the occurrence key. Before Wave 0
   * the marker had no occurrence component, so an escalation title woke a
   * human exactly once ever and every recurrence was silently swallowed.
   *
   * Returns the pending file path when newly emitted, or null when skipped.
   */
  emitOnce(input: WakeEmitInput): string | null;
}

const WAKE_SLUG_MAX = 96;
const OCCURRENCE_HASH_CHARS = 16;

const wakeSlug = (value: string): string =>
  value.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, WAKE_SLUG_MAX);

/**
 * Notified-marker filename.
 *
 * @remarks
 * Two length hazards, both of which would silently collapse every
 * occurrence back onto a single marker and reintroduce the once-ever bug
 * `occurrenceKey` exists to fix:
 *
 * - Escalation titles routinely approach {@link WAKE_SLUG_MAX}, so the
 *   suffix is reserved *before* the base is truncated rather than slugging
 *   `base + suffix` wholesale.
 * - Truncating the occurrence key itself would make any two keys sharing a
 *   prefix indistinguishable, so it is hashed to a fixed-width digest
 *   instead. Keys are arbitrary strings, not necessarily SHAs that happen
 *   to differ early.
 */
const markerName = (
  kind: string,
  dedupeKey: string,
  occurrenceKey?: string
): string => {
  const base = wakeSlug(`${kind}-${dedupeKey}`);
  if (occurrenceKey === undefined || occurrenceKey.length === 0) {
    return base;
  }
  const suffix = `-${createHash('sha1')
    .update(occurrenceKey)
    .digest('hex')
    .slice(0, OCCURRENCE_HASH_CHARS)}`;
  return `${base.slice(0, WAKE_SLUG_MAX - suffix.length)}${suffix}`;
};

const defaultWakeRoot = (): string =>
  process.env.ROSETTA_WAKE_DIR ?? path.join(os.homedir(), '.rosetta', 'wake');

@injectable()
export class WakeInboxRepository implements IWakeInboxRepository {
  emit(input: WakeEmitInput): string {
    const root = input.wakeDir ?? defaultWakeRoot();
    const pending = path.join(root, 'pending');
    mkdirSync(pending, { recursive: true });

    const slug = wakeSlug(`${input.kind}-${input.dedupeKey}`);
    const file = path.join(pending, `${slug}.json`);
    const tmp = `${file}.tmp.${process.pid}`;

    const payload = {
      kind: input.kind,
      dedupeKey: input.dedupeKey,
      prompt: input.prompt,
      data: input.data ?? {},
      createdAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      pid: process.pid
    };

    writeFileSync(tmp, `${JSON.stringify(payload)}\n`);
    renameSync(tmp, file);
    return file;
  }

  emitOnce(input: WakeEmitInput): string | null {
    const root = input.wakeDir ?? defaultWakeRoot();
    const notifiedDir = path.join(root, 'notified');
    mkdirSync(notifiedDir, { recursive: true });
    const marker = path.join(
      notifiedDir,
      markerName(input.kind, input.dedupeKey, input.occurrenceKey)
    );
    if (existsSync(marker)) {
      return null;
    }
    const file = this.emit(input);
    writeFileSync(marker, '');
    return file;
  }
}
