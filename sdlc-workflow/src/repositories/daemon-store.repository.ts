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

export interface WakeWriteResult {
  record: WakeEvent;
  created: boolean;
}

export interface DaemonStorePaths {
  root: string;
  watches: string;
  wake: string;
  pendingWakes: string;
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

const recordFile = (directory: string, id: string): string => {
  if (typeof id !== 'string' || id.length === 0) {
    throw new TypeError('Daemon store record ID must be non-empty');
  }
  const filename = createHash('sha256').update(id).digest('hex');
  return path.join(directory, `${filename}${JSON_SUFFIX}`);
};

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

const syncDirectory = (directory: string): void => {
  const fd = openSync(directory, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
};

/**
 * Publish a fully fsynced file only when `file` does not exist. A hard link is
 * an atomic no-overwrite operation on the same filesystem, unlike rename,
 * which would replace a winner selected by an earlier concurrent writer.
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
      if (
        typeof error !== 'object' ||
        error === null ||
        'code' in error === false ||
        error.code !== 'EEXIST'
      ) {
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

@injectable()
export class DaemonStoreRepository implements IDaemonStoreRepository {
  paths(workspaceRoot: string): DaemonStorePaths {
    const root = deriveDaemonRuntimePaths(
      requireWorkspaceRoot(workspaceRoot)
    ).stateDir;
    const wake = path.join(root, 'wake');
    return {
      root,
      watches: path.join(root, 'watches'),
      wake,
      pendingWakes: path.join(wake, 'pending'),
      consumedWakes: path.join(wake, 'consumed')
    };
  }

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

  readWatch<T extends DurableWatchRecord>(
    workspaceRoot: string,
    id: string
  ): T | null {
    const file = recordFile(this.paths(workspaceRoot).watches, id);
    return existsSync(file) ? parseRecord<T>(file) : null;
  }

  listWatches<T extends DurableWatchRecord>(workspaceRoot: string): T[] {
    return listRecords<T>(this.paths(workspaceRoot).watches);
  }

  writeWake(workspaceRoot: string, input: WakeEventInput): WakeWriteResult {
    const paths = this.paths(workspaceRoot);
    mkdirSync(paths.pendingWakes, { recursive: true });
    mkdirSync(paths.consumedWakes, { recursive: true });
    const record: WakeEvent = { id: wakeEventId(input), ...input };
    const pendingFile = wakeFile(paths.pendingWakes, record.id);
    const consumedFile = wakeFile(paths.consumedWakes, record.id);

    if (existsSync(consumedFile)) {
      return { record: parseRecord<WakeEvent>(consumedFile), created: false };
    }
    const created = writeFileExclusiveAtomic(
      pendingFile,
      `${JSON.stringify(record, null, 2)}\n`
    );
    return {
      record: created ? record : parseRecord<WakeEvent>(pendingFile),
      created
    };
  }

  readWake(workspaceRoot: string, id: string): WakeEvent | null {
    const paths = this.paths(workspaceRoot);
    const pendingFile = wakeFile(paths.pendingWakes, id);
    if (existsSync(pendingFile)) {
      return parseRecord<WakeEvent>(pendingFile);
    }
    const consumedFile = wakeFile(paths.consumedWakes, id);
    return existsSync(consumedFile)
      ? parseRecord<WakeEvent>(consumedFile)
      : null;
  }

  listPendingWakes(workspaceRoot: string): WakeEvent[] {
    return listRecords<WakeEvent>(this.paths(workspaceRoot).pendingWakes);
  }

  async claimWake(
    workspaceRoot: string,
    id: string
  ): Promise<WakeEvent | null> {
    const paths = this.paths(workspaceRoot);
    mkdirSync(paths.consumedWakes, { recursive: true });
    const pendingFile = wakeFile(paths.pendingWakes, id);
    const consumedFile = wakeFile(paths.consumedWakes, id);

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
