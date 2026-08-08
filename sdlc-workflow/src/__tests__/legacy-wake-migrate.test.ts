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

    const approveFromRepo = mapLegacyWakeToInput({
      filePath: '/tmp/a2.json',
      kind: 'pr_approve',
      dedupeKey: 'Owner/repo#2-approved',
      prompt: 'approved',
      data: { signal: 'approved', repo: 'Owner/repo', number: 2 },
      createdAt: '2026-08-07T12:00:00Z'
    });
    expect(approveFromRepo.target).toBe('Owner/repo#2');

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

    const supervisorNoReason = mapLegacyWakeToInput({
      filePath: '/tmp/c2.json',
      kind: 'sdlc_supervisor',
      dedupeKey: 'run-exit',
      prompt: 'exit',
      data: { runId: 'run' },
      createdAt: '2026-08-07T12:00:00Z'
    });
    expect(supervisorNoReason.signal).toBe('exit');

    const unknown = mapLegacyWakeToInput({
      filePath: '/tmp/d.json',
      kind: 'custom_kind',
      dedupeKey: 'k',
      prompt: 'p',
      data: {},
      createdAt: '2026-08-07T12:00:00Z'
    });
    expect(unknown).toMatchObject({
      kind: 'custom_kind',
      target: 'k',
      signal: 'legacy'
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

  it('disposition=pending leaves every wake for daemon drain', async () => {
    const workspace = mkdtempSync(
      path.join(os.tmpdir(), 'legacy-migrate-pending-')
    );
    const wakeRoot = mkdtempSync(
      path.join(os.tmpdir(), 'legacy-migrate-pending-wake-')
    );
    writeDaemonConfig(workspace);
    writeLegacy(wakeRoot, 'pr_approve-Owner-repo-2-approved', {
      kind: 'pr_approve',
      dedupeKey: 'Owner/repo#2-approved',
      prompt: 'PR approve',
      data: {
        signal: 'approved',
        repo: 'Owner/repo',
        number: 2,
        target: 'Owner/repo#2'
      },
      createdAt: '2026-08-07T12:00:00Z'
    });

    const report = await buildService().migrate(workspace, {
      fromWakeDir: wakeRoot,
      disposition: 'pending'
    });
    expect(report.items[0]?.disposition).toBe('pending');
    expect(
      new DaemonStoreRepository().listPendingWakes(workspace)
    ).toHaveLength(1);
    expect(new DaemonStoreRepository().listConsumedWakes(workspace)).toEqual(
      []
    );
  });

  it('disposition=consumed claims every wake as legacy-migrate', async () => {
    const workspace = mkdtempSync(
      path.join(os.tmpdir(), 'legacy-migrate-consumed-')
    );
    const wakeRoot = mkdtempSync(
      path.join(os.tmpdir(), 'legacy-migrate-consumed-wake-')
    );
    writeDaemonConfig(workspace);
    writeLegacy(wakeRoot, 'sdlc_escalation-run-merge-blocked', {
      kind: 'sdlc_escalation',
      dedupeKey: 'ACTION REQUIRED: run',
      prompt: 'esc',
      data: { runId: 'run', trigger: 'merge-blocked' },
      createdAt: '2026-08-07T12:00:00Z'
    });

    const report = await buildService().migrate(workspace, {
      fromWakeDir: wakeRoot,
      disposition: 'consumed'
    });
    expect(report.items[0]?.disposition).toBe('consumed');
    expect(new DaemonStoreRepository().listPendingWakes(workspace)).toEqual([]);
    const consumed = new DaemonStoreRepository().listConsumedWakes(workspace);
    expect(consumed).toHaveLength(1);
    expect(consumed[0]?.consumedBy).toBe(LEGACY_MIGRATE_CONSUMER_ID);
  });

  it('skips malformed pending files and migrates nothing from an empty inbox', async () => {
    const workspace = mkdtempSync(
      path.join(os.tmpdir(), 'legacy-migrate-empty-')
    );
    const wakeRoot = mkdtempSync(
      path.join(os.tmpdir(), 'legacy-migrate-empty-wake-')
    );
    writeDaemonConfig(workspace);
    mkdirSync(path.join(wakeRoot, 'pending'), { recursive: true });
    writeFileSync(
      path.join(wakeRoot, 'pending', 'broken.json'),
      '{not-json\n',
      'utf-8'
    );
    writeFileSync(
      path.join(wakeRoot, 'pending', 'incomplete.json'),
      JSON.stringify({ kind: 'pr_approve' }),
      'utf-8'
    );

    const report = await buildService().migrate(workspace, {
      fromWakeDir: wakeRoot
    });
    expect(report.items).toEqual([]);
    expect(new LegacyWakeInboxRepository().listPending(wakeRoot)).toEqual([]);
  });
});

describe('LegacyWakeInboxRepository', () => {
  it('resolveRoot prefers an explicit path over the default', () => {
    const repo = new LegacyWakeInboxRepository();
    const explicit = mkdtempSync(path.join(os.tmpdir(), 'legacy-wake-root-'));
    expect(repo.resolveRoot(explicit)).toBe(path.resolve(explicit));
    expect(repo.resolveRoot('')).toBe(repo.resolveRoot());
  });

  it('archivePending is a no-op when the source file is already gone', () => {
    const repo = new LegacyWakeInboxRepository();
    const wakeRoot = mkdtempSync(path.join(os.tmpdir(), 'legacy-wake-arch-'));
    expect(() =>
      repo.archivePending(
        path.join(wakeRoot, 'pending', 'missing.json'),
        wakeRoot
      )
    ).not.toThrow();
  });

  it('listPending returns [] when pending/ is missing or holds arrays', () => {
    const repo = new LegacyWakeInboxRepository();
    const missing = mkdtempSync(path.join(os.tmpdir(), 'legacy-wake-miss-'));
    expect(repo.listPending(missing)).toEqual([]);

    const wakeRoot = mkdtempSync(path.join(os.tmpdir(), 'legacy-wake-arr-'));
    mkdirSync(path.join(wakeRoot, 'pending'), { recursive: true });
    writeFileSync(
      path.join(wakeRoot, 'pending', 'array.json'),
      JSON.stringify([{ kind: 'x' }]),
      'utf-8'
    );
    expect(repo.listPending(wakeRoot)).toEqual([]);
  });
});

describe('LegacyWakeMigrateService claim races', () => {
  it('leaves disposition pending when claimWake returns null without consumedBy', async () => {
    const workspace = mkdtempSync(
      path.join(os.tmpdir(), 'legacy-migrate-race-')
    );
    const wakeRoot = mkdtempSync(
      path.join(os.tmpdir(), 'legacy-migrate-race-wake-')
    );
    writeLegacy(wakeRoot, 'sdlc_escalation-race', {
      kind: 'sdlc_escalation',
      dedupeKey: 'race',
      prompt: 'esc',
      data: { runId: 'race-run', trigger: 'merge-blocked' },
      createdAt: '2026-08-07T12:00:00Z'
    });

    const container = new Container();
    container.bind(WORKFLOW_TOKENS.DaemonStoreRepository).toConstantValue({
      writeWake: jest.fn().mockReturnValue({
        created: true,
        record: {
          id: 'wake-race',
          kind: 'sdlc_escalation',
          target: 'race-run',
          signal: 'merge-blocked',
          createdAt: '2026-08-07T12:00:00Z'
        }
      }),
      claimWake: jest.fn().mockResolvedValue(null),
      recordWakeConsumed: jest.fn()
    });
    container
      .bind(WORKFLOW_TOKENS.LegacyWakeInboxRepository)
      .to(LegacyWakeInboxRepository);
    container
      .bind(WORKFLOW_TOKENS.LegacyWakeMigrateService)
      .to(LegacyWakeMigrateService);
    const service = container.get<LegacyWakeMigrateService>(
      WORKFLOW_TOKENS.LegacyWakeMigrateService
    );

    const report = await service.migrate(workspace, {
      fromWakeDir: wakeRoot,
      disposition: 'consumed'
    });
    expect(report.items[0]?.disposition).toBe('pending');
  });
});
