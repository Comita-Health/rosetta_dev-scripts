import { mkdirSync, writeFileSync, renameSync } from 'fs';
import { injectable } from 'inversify';
import os from 'os';
import path from 'path';

/**
 * Durable agent wake inbox — TypeScript mirror of `scripts/wake-inbox.sh`.
 *
 * Writes `$ROSETTA_WAKE_DIR/pending/<slug>.json` (default
 * `~/.rosetta/wake/pending`) so a supervise exit survives a dead terminal and
 * is drained by the Cursor stop hook (#38 / fail-loud T-02).
 */
export interface WakeEmitInput {
  kind: string;
  dedupeKey: string;
  prompt: string;
  data?: Record<string, unknown>;
  /** Override root for tests (`…/wake`); production leaves unset. */
  wakeDir?: string;
}

export interface IWakeInboxRepository {
  emit(input: WakeEmitInput): string;
}

const wakeSlug = (value: string): string =>
  value.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 96);

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
}
