import 'reflect-metadata';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import {
  DeployRecordRepository,
  IDeployRecordRepository
} from '../repositories/deploy-record.repository';

describe('DeployRecordRepository (SPEC-PRD-0022-P1 T-01)', () => {
  let repo: IDeployRecordRepository;
  let runsDir: string;
  const runId = 'run-1';

  beforeEach(() => {
    repo = new DeployRecordRepository();
    runsDir = mkdtempSync(path.join(os.tmpdir(), 'sdlc-deploys-'));
  });

  afterEach(() => {
    rmSync(runsDir, { recursive: true, force: true });
  });

  const begin = (over: Partial<Parameters<typeof repo.begin>[0]> = {}) =>
    repo.begin({
      runsDir,
      runId,
      contentSha: 'tree-1',
      commitSha: 'commit-1',
      trigger: 'task',
      taskId: 'T-01',
      ...over
    });

  it('records the content SHA, trigger, workflow reference and outcome of a dispatch', () => {
    const started = begin();
    expect(started).toMatchObject({
      contentSha: 'tree-1',
      commitSha: 'commit-1',
      trigger: 'task',
      taskId: 'T-01',
      status: 'in-flight'
    });

    repo.finish(runsDir, runId, started, {
      status: 'healthy',
      workflowRef: 'https://github.com/org/repo/actions/runs/7'
    });

    expect(repo.list(runsDir, runId)).toEqual([
      expect.objectContaining({ status: 'in-flight' }),
      expect.objectContaining({
        contentSha: 'tree-1',
        commitSha: 'commit-1',
        trigger: 'task',
        status: 'healthy',
        workflowRef: 'https://github.com/org/repo/actions/runs/7'
      })
    ]);
  });

  it('keys two different commits with identical trees to the same record', () => {
    // The whole point of the content key: a merge commit and the PR head it
    // merged have different commit SHAs and the same tree.
    const head = begin({ commitSha: 'pr-head' });
    repo.finish(runsDir, runId, head, { status: 'healthy' });

    const found = repo.latestForContent(runsDir, runId, 'tree-1');

    expect(found).toMatchObject({ commitSha: 'pr-head', status: 'healthy' });
    // Same content reached from the merge commit's side.
    expect(repo.latestForContent(runsDir, runId, 'tree-1')?.contentSha).toBe(
      'tree-1'
    );
    expect(repo.latestForContent(runsDir, runId, 'other-tree')).toBeNull();
  });

  it('reads records written by an earlier process, after the run ended', () => {
    // Survives restart because the ledger is a run artifact on disk, not
    // in-memory state — a fresh instance with only the run ID can read it.
    const first = new DeployRecordRepository();
    const started = first.begin({
      runsDir,
      runId,
      contentSha: 'tree-9',
      commitSha: 'commit-9',
      trigger: 'phase-boundary'
    });
    first.finish(runsDir, runId, started, { status: 'healthy' });

    const afterRestart = new DeployRecordRepository();

    expect(afterRestart.list(runsDir, runId)).toHaveLength(2);
    expect(
      afterRestart.latestForContent(runsDir, runId, 'tree-9')
    ).toMatchObject({ trigger: 'phase-boundary', status: 'healthy' });
  });

  it('records a skipped dispatch as its own event, naming what it reused', () => {
    const head = begin({ commitSha: 'pr-head' });
    repo.finish(runsDir, runId, head, { status: 'healthy' });

    repo.recordReuse({
      runsDir,
      runId,
      contentSha: 'tree-1',
      commitSha: 'merge-commit',
      trigger: 'merge',
      reusedFrom: 'pr-head'
    });

    expect(repo.list(runsDir, runId)[2]).toMatchObject({
      commitSha: 'merge-commit',
      status: 'reused',
      reusedFrom: 'pr-head'
    });
  });

  it('still reports the live deploy after a reuse was recorded against it', () => {
    // Dedup that works exactly once is worse than none: it looks fixed. A
    // reuse describes a dispatch that did not happen, so the healthy record
    // stays the answer for the next caller.
    const head = begin({ commitSha: 'pr-head' });
    repo.finish(runsDir, runId, head, { status: 'healthy' });
    repo.recordReuse({
      runsDir,
      runId,
      contentSha: 'tree-1',
      commitSha: 'merge-commit',
      trigger: 'merge',
      reusedFrom: 'pr-head'
    });

    expect(repo.latestForContent(runsDir, runId, 'tree-1')).toMatchObject({
      commitSha: 'pr-head',
      status: 'healthy'
    });
  });

  it('reports the terminal outcome rather than the in-flight marker it replaced', () => {
    const started = begin();
    expect(repo.latestForContent(runsDir, runId, 'tree-1')?.status).toBe(
      'in-flight'
    );

    repo.finish(runsDir, runId, started, { status: 'failed' });

    expect(repo.latestForContent(runsDir, runId, 'tree-1')?.status).toBe(
      'failed'
    );
  });

  it('keeps the workflow reference from the dispatch when the outcome adds none', () => {
    const started = begin();
    started.workflowRef = 'https://github.com/org/repo/actions/runs/3';

    const finished = repo.finish(runsDir, runId, started, {
      status: 'healthy'
    });

    expect(finished.workflowRef).toBe(
      'https://github.com/org/repo/actions/runs/3'
    );
  });

  it('reads an empty ledger as no records at all', () => {
    expect(repo.list(runsDir, 'never-ran')).toEqual([]);
    expect(repo.latestForContent(runsDir, 'never-ran', 'tree-1')).toBeNull();
  });

  it('reads past a line torn by a kill mid-append', () => {
    // One unparseable line must not blind every skip decision after it.
    const started = begin();
    repo.finish(runsDir, runId, started, { status: 'healthy' });
    const file = path.join(runsDir, runId, 'deploys.jsonl');
    mkdirSync(path.dirname(file), { recursive: true });
    appendFileSync(file, '{"contentSha":"tree-1","statu\n');

    expect(repo.list(runsDir, runId)).toHaveLength(2);
    expect(repo.latestForContent(runsDir, runId, 'tree-1')?.status).toBe(
      'healthy'
    );
  });
});
