import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'fs';
import { injectable } from 'inversify';
import path from 'path';
import type { DeployRecord, DeployTrigger } from '../types';

/**
 * Append-only ledger of every sandbox deploy the engine dispatched, keyed by
 * the **tree-content SHA** it deployed (SPEC-PRD-0022-P1 T-01).
 *
 * Content, not commit: a merge commit has a different SHA from the PR head it
 * merged even when the resulting tree is byte-identical, so a commit-keyed
 * ledger reports "never deployed" for content that is already live and pays
 * for the deploy twice. Every skip decision downstream (merge-path dedup in
 * T-02, phase-boundary race avoidance in T-03) is only as correct as this key.
 *
 * @remarks
 * Append-only JSONL rather than a mutable document, for two reasons. A deploy
 * is dispatched *before* its outcome is known, so the in-flight marker and its
 * terminal record are two events, and collapsing them would lose the window
 * where a concurrent trigger needs to see "someone is already deploying this".
 * And appends from two processes cannot lose each other's lines the way a
 * read-modify-write of one JSON document can.
 *
 * Lives under the run directory, so records survive process restart and stay
 * readable by run ID after the run ends.
 */
export interface IDeployRecordRepository {
  /**
   * Mark a deploy of `contentSha` as started and return the record. Written
   * before dispatch so a concurrent trigger can see the in-flight window.
   */
  begin(input: DeployBeginInput): DeployRecord;
  /** Record the terminal outcome of a previously begun deploy. */
  finish(
    runsDir: string,
    runId: string,
    record: DeployRecord,
    outcome: { status: 'healthy' | 'failed'; workflowRef?: string }
  ): DeployRecord;
  /**
   * Record that a deploy was *not* dispatched because `reusedFrom` already
   * has this content live. A skip is an event with a reason, not the absence
   * of one — without it, "no deploy happened" is indistinguishable from a
   * dedup bug that lost the dispatch.
   */
  recordReuse(input: DeployReuseInput): DeployRecord;
  /** Every record for the run, oldest first. */
  list(runsDir: string, runId: string): DeployRecord[];
  /**
   * The record that describes what is *live* for `contentSha`, or null.
   *
   * @remarks
   * "Latest" matters twice. An in-flight marker followed by a terminal record
   * must read as the terminal one. And `reused` records are skipped rather
   * than returned: a reuse is a statement about a dispatch that did not
   * happen, so returning it would make the third deploy of the same content
   * see neither a healthy deploy nor an in-flight one and dispatch anyway —
   * dedup that works exactly once is worse than none, because it looks fixed.
   */
  latestForContent(
    runsDir: string,
    runId: string,
    contentSha: string
  ): DeployRecord | null;
}

export interface DeployBeginInput {
  runsDir: string;
  runId: string;
  contentSha: string;
  commitSha: string;
  trigger: DeployTrigger;
  taskId?: string;
}

export interface DeployReuseInput extends DeployBeginInput {
  /** Commit SHA of the deploy whose content is being reused. */
  reusedFrom: string;
}

const ledgerFile = (runsDir: string, runId: string): string =>
  path.join(runsDir, runId, 'deploys.jsonl');

@injectable()
export class DeployRecordRepository implements IDeployRecordRepository {
  begin(input: DeployBeginInput): DeployRecord {
    return this.append(input.runsDir, input.runId, {
      contentSha: input.contentSha,
      commitSha: input.commitSha,
      trigger: input.trigger,
      taskId: input.taskId,
      status: 'in-flight',
      recordedAt: new Date().toISOString()
    });
  }

  finish(
    runsDir: string,
    runId: string,
    record: DeployRecord,
    outcome: { status: 'healthy' | 'failed'; workflowRef?: string }
  ): DeployRecord {
    return this.append(runsDir, runId, {
      ...record,
      status: outcome.status,
      workflowRef: outcome.workflowRef ?? record.workflowRef,
      recordedAt: new Date().toISOString()
    });
  }

  recordReuse(input: DeployReuseInput): DeployRecord {
    return this.append(input.runsDir, input.runId, {
      contentSha: input.contentSha,
      commitSha: input.commitSha,
      trigger: input.trigger,
      taskId: input.taskId,
      status: 'reused',
      reusedFrom: input.reusedFrom,
      recordedAt: new Date().toISOString()
    });
  }

  list(runsDir: string, runId: string): DeployRecord[] {
    const file = ledgerFile(runsDir, runId);
    if (!existsSync(file)) return [];
    return readFileSync(file, 'utf-8')
      .split('\n')
      .filter(line => line.trim().length > 0)
      .flatMap(line => {
        try {
          return [JSON.parse(line) as DeployRecord];
        } catch {
          // One torn line (a kill mid-append) must not blind every skip
          // decision that follows it.
          return [];
        }
      });
  }

  latestForContent(
    runsDir: string,
    runId: string,
    contentSha: string
  ): DeployRecord | null {
    const matches = this.list(runsDir, runId).filter(
      record => record.contentSha === contentSha && record.status !== 'reused'
    );
    return matches.length === 0 ? null : matches[matches.length - 1];
  }

  private append(
    runsDir: string,
    runId: string,
    record: DeployRecord
  ): DeployRecord {
    const file = ledgerFile(runsDir, runId);
    mkdirSync(path.dirname(file), { recursive: true });
    appendFileSync(file, `${JSON.stringify(record)}\n`);
    return record;
  }
}
