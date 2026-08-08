import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { Container } from 'inversify';
import os from 'os';
import path from 'path';
import { DaemonStoreRepository } from '../repositories/daemon-store.repository';
import { LegacyWakeInboxRepository } from '../repositories/legacy-wake-inbox.repository';
import {
  LEGACY_MIGRATE_CONSUMER_ID,
  LegacyWakeMigrateService,
  mapLegacyWakeToInput
} from '../services/legacy-wake-migrate.service';
import { WORKFLOW_TOKENS } from '../tokens';
import type { LegacyWakeRecord } from '../repositories/legacy-wake-inbox.repository';

const writeLegacy = (
  wakeRoot: string,
  slug: string,
  body: Record<string, unknown>
): string => {
  const pending = path.join(wakeRoot, 'pending');
  mkdirSync(pending, { recursive: true });
  const file = path.join(pending, `${slug}.json`);
  writeFileSync(file, `${JSON.stringify(body)}\n`, 'utf-8');
  return file;
};

const writeDaemonConfig = (root: string): void => {
  mkdirSync(path.join(root, '.sdlc'), { recursive: true });
  writeFileSync(
    path.join(root, '.sdlc', 'daemon.json'),
    JSON.stringify({
      activateScript: 'scripts/activate.sh',
      runsDir: 'var/runs',
      defaultPollSeconds: 30,
      headlessRunner: 'test-runner'
    }),
    'utf-8'
  );
};

const buildService = (): LegacyWakeMigrateService => {
  const container = new Container();
  container
    .bind(WORKFLOW_TOKENS.DaemonStoreRepository)
    .to(DaemonStoreRepository);
  container
    .bind(WORKFLOW_TOKENS.LegacyWakeInboxRepository)
    .to(LegacyWakeInboxRepository);
  container
    .bind(WORKFLOW_TOKENS.LegacyWakeMigrateService)
    .to(LegacyWakeMigrateService);
  return container.get(WORKFLOW_TOKENS.LegacyWakeMigrateService);
};

describe('mapLegacyWakeToInput', () => {
  it('maps pr_approve, escalation, and supervisor shapes', () => {
    const approve = mapLegacyWakeToInput({
      filePath: '/tmp/a.json',
      kind: 'pr_approve',
      dedupeKey: 'Owner/repo#1-approved',
      prompt: 'approved',
      data: {
        signal: 'approved',
        repo: 'Owner/repo',
        number: 1,
        target: 'Owner/repo#1'
      },
      createdAt: '2026-08-07T12:00:00Z'
    });
    expect(approve).toMatchObject({
      kind: 'pr_approve',
      target: 'Owner/repo#1',
      signal: 'approved'
    });
    expect(approve.data?.legacyDedupeKey).toBe('Owner/repo#1-approved');

    const escalation = mapLegacyWakeToInput({
      filePath: '/tmp/b.json',
      kind: 'sdlc_escalation',
      dedupeKey: 'title',
      prompt: 'esc',
      data: {
        runId: 'bug-run',
        taskId: 'T-01',
        trigger: 'merge-blocked'
      },
      createdAt: '2026-08-07T12:00:00Z'
    });
    expect(escalation).toMatchObject({
      kind: 'sdlc_escalation',
      target: 'bug-run',
      signal: 'merge-blocked'
    });

    const supervisor: LegacyWakeRecord = {
      filePath: '/tmp/c.json',
      kind: 'sdlc_supervisor',
      dedupeKey: 'bug-run-exit',
      prompt: 'exit',
      data: { runId: 'bug-run', reason: 'merge-blocked', code: 1 },
      createdAt: '2026-08-07T12:00:00Z'
    };
    expect(mapLegacyWakeToInput(supervisor)).toMatchObject({
      kind: 'sdlc_supervisor',
      target: 'bug-run',
      signal: 'merge-blocked'
    });
  });
});

describe('LegacyWakeMigrateService', () => {
  it('auto-consumes pr_approve and leaves escalations pending', async () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), 'legacy-migrate-ws-'));
    const wakeRoot = mkdtempSync(
      path.join(os.tmpdir(), 'legacy-migrate-wake-')
    );
    writeDaemonConfig(workspace);
    writeLegacy(wakeRoot, 'pr_approve-Owner-repo-9-approved', {
      kind: 'pr_approve',
      dedupeKey: 'Owner/repo#9-approved',
      prompt: 'PR approve',
      data: {
        signal: 'approved',
        repo: 'Owner/repo',
        number: 9,
        target: 'Owner/repo#9'
      },
      createdAt: '2026-08-07T12:00:00Z'
    });
    writeLegacy(wakeRoot, 'sdlc_escalation-bug-run-merge-blocked', {
      kind: 'sdlc_escalation',
      dedupeKey: 'ACTION REQUIRED: bug-run',
      prompt: 'SDLC escalation',
      data: {
        runId: 'bug-run',
        taskId: 'T-01',
        trigger: 'merge-blocked'
      },
      createdAt: '2026-08-07T12:01:00Z'
    });

    const report = await buildService().migrate(workspace, {
      fromWakeDir: wakeRoot,
      disposition: 'auto'
    });

    expect(report.items).toHaveLength(2);
    const approve = report.items.find(item => item.kind === 'pr_approve');
    const escalation = report.items.find(
      item => item.kind === 'sdlc_escalation'
    );
    expect(approve?.disposition).toBe('consumed');
    expect(escalation?.disposition).toBe('pending');

    const store = new DaemonStoreRepository();
    const pending = store.listPendingWakes(workspace);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.kind).toBe('sdlc_escalation');
    expect(pending[0]?.target).toBe('bug-run');

    const consumed = store.listConsumedWakes(workspace);
    expect(consumed).toHaveLength(1);
    expect(consumed[0]?.consumedBy).toBe(LEGACY_MIGRATE_CONSUMER_ID);

    const legacyPending = new LegacyWakeInboxRepository().listPending(wakeRoot);
    expect(legacyPending).toEqual([]);
    const archived = readFileSync(
      path.join(wakeRoot, 'consumed', 'pr_approve-Owner-repo-9-approved.json'),
      'utf-8'
    );
    expect(archived).toContain('pr_approve');
  });

  it('dry-run does not write or archive', async () => {
    const workspace = mkdtempSync(
      path.join(os.tmpdir(), 'legacy-migrate-dry-')
    );
    const wakeRoot = mkdtempSync(
      path.join(os.tmpdir(), 'legacy-migrate-dry-wake-')
    );
    writeDaemonConfig(workspace);
    writeLegacy(wakeRoot, 'sdlc_supervisor-run-exit', {
      kind: 'sdlc_supervisor',
      dedupeKey: 'run-exit',
      prompt: 'exit',
      data: { runId: 'run', reason: 'merge-blocked' },
      createdAt: '2026-08-07T12:00:00Z'
    });

    const report = await buildService().migrate(workspace, {
      fromWakeDir: wakeRoot,
      dryRun: true
    });
    expect(report.items[0]?.disposition).toBe('dry-run');
    expect(new DaemonStoreRepository().listPendingWakes(workspace)).toEqual([]);
    expect(new LegacyWakeInboxRepository().listPending(wakeRoot)).toHaveLength(
      1
    );
  });
});
