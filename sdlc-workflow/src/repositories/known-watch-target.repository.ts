import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { injectable } from 'inversify';
import path from 'path';
import type { DaemonStatusUnwatched, RunState, WatchKind } from '../types';

/**
 * Discovers watchable targets from durable engine artifacts under a
 * workspace's configured `runsDir` — never from hardcoded org/repo lists.
 *
 * Sources:
 * - each run directory with `state.json` → `run-supervisor`
 * - each task `prUrl` on those states → `pr-review` and `pr-checks`
 * - each queued launch record → `queue-item`
 */
export interface IKnownWatchTargetRepository {
  list(runsDir: string): DaemonStatusUnwatched[];
}

/** `https://github.com/owner/repo/pull/42` (optional trailing slash). */
const GITHUB_PR_URL =
  /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/)?$/i;

const parsePrUrl = (prUrl: string): { repo: string; number: number } | null => {
  const match = GITHUB_PR_URL.exec(prUrl.trim());
  if (match === null) {
    return null;
  }
  const number = Number(match[3]);
  // Placeholder /bad fixture URLs (e.g. …/pull/0) must not surface as
  // unwatched targets — watchRegistrationId rejects non-positive numbers.
  if (Number.isSafeInteger(number) === false || number <= 0) {
    return null;
  }
  return {
    repo: `${match[1]}/${match[2]}`.toLowerCase(),
    number
  };
};

const targetKey = (
  kind: WatchKind,
  target: DaemonStatusUnwatched['target']
): string => `${kind}:${JSON.stringify(target)}`;

@injectable()
export class KnownWatchTargetRepository implements IKnownWatchTargetRepository {
  /**
   * Scan `runsDir` for active runs, task PRs, and queued launches.
   * Missing or unreadable directories yield an empty list — status still
   * renders watches/wakes from the daemon store.
   */
  list(runsDir: string): DaemonStatusUnwatched[] {
    if (typeof runsDir !== 'string' || runsDir.trim().length === 0) {
      return [];
    }
    const root = path.resolve(runsDir.trim());
    if (existsSync(root) === false) {
      return [];
    }

    const byKey = new Map<string, DaemonStatusUnwatched>();
    const add = (entry: DaemonStatusUnwatched): void => {
      const key = targetKey(entry.kind, entry.target);
      if (byKey.has(key) === false) {
        byKey.set(key, entry);
      }
    };

    let entries: string[] = [];
    try {
      entries = readdirSync(root);
    } catch {
      return [];
    }

    for (const name of entries) {
      if (name === 'queue') {
        continue;
      }
      const runPath = path.join(root, name);
      let isDirectory = false;
      try {
        isDirectory = statSync(runPath).isDirectory();
      } catch {
        continue;
      }
      if (isDirectory === false) {
        continue;
      }
      const stateFile = path.join(runPath, 'state.json');
      if (existsSync(stateFile) === false) {
        continue;
      }
      add({
        kind: 'run-supervisor',
        target: { runId: name },
        source: 'active-run'
      });
      const state = this.readState(stateFile);
      if (state === null) {
        continue;
      }
      for (const result of Object.values(state.taskResults ?? {})) {
        if (typeof result.prUrl !== 'string' || result.prUrl.length === 0) {
          continue;
        }
        const parsed = parsePrUrl(result.prUrl);
        if (parsed === null) {
          continue;
        }
        for (const kind of ['pr-review', 'pr-checks'] as const) {
          add({
            kind,
            target: { repo: parsed.repo, number: parsed.number },
            source: 'task-pr'
          });
        }
      }
    }

    const queueDir = path.join(root, 'queue');
    if (existsSync(queueDir)) {
      let queueNames: string[] = [];
      try {
        queueNames = readdirSync(queueDir).filter(n => n.endsWith('.json'));
      } catch {
        queueNames = [];
      }
      for (const name of queueNames) {
        const record = this.readJson(path.join(queueDir, name));
        if (record === null) {
          continue;
        }
        const runId =
          typeof record.runId === 'string' && record.runId.trim().length > 0
            ? record.runId.trim()
            : typeof record.specPath === 'string' &&
                record.specPath.trim().length > 0
              ? record.specPath.trim()
              : null;
        if (runId === null) {
          continue;
        }
        add({
          kind: 'queue-item',
          target: { runId },
          source: 'queued-launch'
        });
      }
    }

    return [...byKey.values()].sort((left, right) =>
      targetKey(left.kind, left.target).localeCompare(
        targetKey(right.kind, right.target)
      )
    );
  }

  private readState(file: string): RunState | null {
    const raw = this.readJson(file);
    if (raw === null || typeof raw.runId !== 'string') {
      return null;
    }
    return raw as unknown as RunState;
  }

  private readJson(file: string): Record<string, unknown> | null {
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, 'utf-8'));
      if (
        typeof parsed !== 'object' ||
        parsed === null ||
        Array.isArray(parsed)
      ) {
        return null;
      }
      return parsed as Record<string, unknown>;
    } catch {
      return null;
    }
  }
}
