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

export interface IWatchRegistryService {
  register(
    workspaceRoot: string,
    input: WatchRegistrationInput
  ): DurableWatchRecord;
  get(workspaceRoot: string, id: string): DurableWatchRecord | null;
  getByTarget(
    workspaceRoot: string,
    kind: WatchKind,
    target: WatchTarget
  ): DurableWatchRecord | null;
  list(workspaceRoot: string): ActiveWatch[];
  recordPoll(
    workspaceRoot: string,
    id: string,
    result?: WatchPollResult
  ): DurableWatchRecord | null;
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

const normalizeTarget = (target: WatchTarget): WatchTarget => {
  if (typeof target !== 'object' || target === null) {
    throw new TypeError('Watch registration target must be an object');
  }
  const normalized: WatchTarget = {};
  if (target.repo !== undefined) {
    normalized.repo = requireText(target.repo, 'target.repo');
  }
  if (target.number !== undefined) {
    if (Number.isSafeInteger(target.number) === false || target.number <= 0) {
      throw new TypeError(
        'Watch registration target.number must be a positive integer'
      );
    }
    normalized.number = target.number;
  }
  if (target.runId !== undefined) {
    normalized.runId = requireText(target.runId, 'target.runId');
  }
  if (
    normalized.repo === undefined &&
    normalized.number === undefined &&
    normalized.runId === undefined
  ) {
    throw new TypeError('Watch registration target must identify a resource');
  }
  return normalized;
};

/** Stable, order-independent identity required by PRD-0020 §4. */
export const watchRegistrationId = (
  kind: WatchKind,
  target: WatchTarget
): string => `${kind}:${JSON.stringify(normalizeTarget(target))}`;

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

  register(
    workspaceRoot: string,
    input: WatchRegistrationInput
  ): DurableWatchRecord {
    this.validateInput(input);
    const target = normalizeTarget(input.target);
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

  get(workspaceRoot: string, id: string): DurableWatchRecord | null {
    const record = this._store.readWatch<DurableWatchRecord>(workspaceRoot, id);
    if (record === null) {
      return null;
    }
    return this.activeRecord(workspaceRoot, record, new Date().toISOString());
  }

  getByTarget(
    workspaceRoot: string,
    kind: WatchKind,
    target: WatchTarget
  ): DurableWatchRecord | null {
    return this.get(workspaceRoot, watchRegistrationId(kind, target));
  }

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
        lastPollTime: record.lastPollTime ?? null
      }));
  }

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
    const updated: DurableWatchRecord = { ...record, lastPollTime: now };
    if (result.terminalState !== undefined) {
      updated.terminalState = requireText(
        result.terminalState,
        'terminalState'
      );
      updated.expiredAt = now;
    }
    return this._store.writeWatch(workspaceRoot, updated);
  }

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
    normalizeTarget(input.target);
    validateDate(input.expiresAt, 'expiresAt');
    if (input.action !== undefined) {
      requireText(input.action.transcriptDir, 'action.transcriptDir');
    }
  }
}
