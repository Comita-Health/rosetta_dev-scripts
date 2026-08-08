import { mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { Container } from 'inversify';
import os from 'os';
import path from 'path';
import { DaemonHandler } from '../handlers/daemon.handler';
import { DaemonConfigRepository } from '../repositories/daemon-config.repository';
import { DaemonStoreRepository } from '../repositories/daemon-store.repository';
import { KnownWatchTargetRepository } from '../repositories/known-watch-target.repository';
import { DAEMON_STATUS_JSON_SCHEMA } from '../services/daemon-status.schema';
import { DaemonStatusService } from '../services/daemon-status.service';
import { WatchRegistryService } from '../services/watch-registry.service';
import { WORKFLOW_TOKENS } from '../tokens';
import { validateJson } from '../utils/json-schema';

const writeDaemonConfig = (root: string, runsDir = 'var/runs'): void => {
  mkdirSync(path.join(root, '.sdlc'), { recursive: true });
  writeFileSync(
    path.join(root, '.sdlc', 'daemon.json'),
    JSON.stringify({
      activateScript: 'scripts/activate.sh',
      runsDir,
      defaultPollSeconds: 30,
      headlessRunner: 'test-runner'
    }),
    'utf-8'
  );
};

const buildHandler = (migrateImpl?: { migrate: jest.Mock }): DaemonHandler => {
  const container = new Container();
  container
    .bind(WORKFLOW_TOKENS.DaemonConfigRepository)
    .to(DaemonConfigRepository);
  container
    .bind(WORKFLOW_TOKENS.DaemonStoreRepository)
    .to(DaemonStoreRepository);
  container.bind(WORKFLOW_TOKENS.WatchRegistryService).to(WatchRegistryService);
  container
    .bind(WORKFLOW_TOKENS.KnownWatchTargetRepository)
    .to(KnownWatchTargetRepository);
  container.bind(WORKFLOW_TOKENS.DaemonStatusService).to(DaemonStatusService);
  container.bind(WORKFLOW_TOKENS.DaemonLifecycleService).toConstantValue({
    run: jest.fn(),
    install: jest.fn(),
    uninstall: jest.fn()
  });
  container.bind(WORKFLOW_TOKENS.LegacyWakeMigrateService).toConstantValue({
    migrate:
      migrateImpl?.migrate ??
      jest.fn().mockResolvedValue({
        fromWakeDir: '/tmp/wake',
        workspaceRoot: '/tmp/ws',
        dryRun: false,
        disposition: 'auto',
        items: []
      })
  });
  // T-08: DaemonHandler also injects WatchRegistryService + DaemonConfigRepository
  // (already bound above) for `daemon watch`.
  container.bind(WORKFLOW_TOKENS.DaemonHandler).to(DaemonHandler);
  return container.get(WORKFLOW_TOKENS.DaemonHandler);
};

describe('daemon status (SPEC-PRD-0020-P1 T-07)', () => {
  const originalLog = console.log;

  afterEach(() => {
    console.log = originalLog;
  });

  it('emits --json output that validates against the fixed status schema', () => {
    const workspace = mkdtempSync(
      path.join(os.tmpdir(), 'daemon-status-json-')
    );
    writeDaemonConfig(workspace);
    const store = new DaemonStoreRepository();
    const registry = new WatchRegistryService(store);
    registry.register(workspace, {
      kind: 'pr-review',
      target: { repo: 'Owner/Repo', number: 7 },
      pollSeconds: 30,
      createdBy: 'test'
    });
    store.writeWake(workspace, {
      kind: 'pr-review',
      target: 'pr-review:{"number":7,"repo":"owner/repo"}',
      signal: 'approved',
      createdAt: '2026-08-07T12:00:00.000Z'
    });

    const lines: string[] = [];
    console.log = (message?: unknown) => {
      if (typeof message === 'string') {
        lines.push(message);
      }
    };

    const report = buildHandler().status({
      workspaceRoot: workspace,
      json: true
    });
    const parsed = JSON.parse(lines.join('\n')) as unknown;
    expect(validateJson(DAEMON_STATUS_JSON_SCHEMA, parsed)).toEqual([]);
    expect(report.watches[0]?.kind).toBe('pr-review');
    expect(report.watches[0]?.age).toBeGreaterThanOrEqual(0);
    expect(report.watches[0]).toHaveProperty('lastPollTime');
    expect(report.wakes).toHaveLength(1);
    expect(report.wakes[0]?.state).toBe('pending');
  });

  it('lists a known PR with no watch in a distinct unwatched section', () => {
    const workspace = mkdtempSync(
      path.join(os.tmpdir(), 'daemon-status-unwatched-')
    );
    const runsDir = path.join(workspace, 'var', 'runs');
    writeDaemonConfig(workspace, runsDir);
    mkdirSync(path.join(runsDir, 'run-abc'), { recursive: true });
    writeFileSync(
      path.join(runsDir, 'run-abc', 'state.json'),
      JSON.stringify({
        runId: 'run-abc',
        specId: 'SPEC-X',
        specPath: '/tmp/spec.md',
        baseSha: 'abc',
        taskResults: {
          'T-01': {
            taskId: 'T-01',
            status: 'merged',
            prUrl: 'https://github.com/Acme/App/pull/99'
          }
        },
        verdicts: [],
        exceptions: [],
        criterionVerdicts: [],
        steps: {},
        tokenSpendK: 0,
        ciFixAttempts: {},
        gateFixAttempts: {},
        remediations: {},
        mergeBlockedRetries: 0,
        updatedAt: '2026-08-07T12:00:00.000Z'
      }),
      'utf-8'
    );

    const report = buildHandler().status({
      workspaceRoot: workspace,
      json: true
    });

    expect(report.watches).toEqual([]);
    expect(report.unwatched.length).toBeGreaterThan(0);
    expect(
      report.unwatched.some(
        entry =>
          entry.kind === 'pr-review' &&
          entry.target.repo === 'acme/app' &&
          entry.target.number === 99
      )
    ).toBe(true);
    expect(
      report.unwatched.some(
        entry =>
          entry.kind === 'run-supervisor' && entry.target.runId === 'run-abc'
      )
    ).toBe(true);

    const lines: string[] = [];
    console.log = (message?: unknown) => {
      if (typeof message === 'string') {
        lines.push(message);
      }
    };
    buildHandler().status({ workspaceRoot: workspace, json: false });
    const text = lines.join('\n');
    expect(text).toMatch(/Unwatched/);
    expect(text).toMatch(/pr-review acme\/app#99/);
    expect(text).toMatch(/run-supervisor run-abc/);
  });

  it('ignores placeholder pull/0 PR URLs so status still renders', () => {
    const workspace = mkdtempSync(
      path.join(os.tmpdir(), 'daemon-status-pull0-')
    );
    const runsDir = path.join(workspace, 'var', 'runs');
    writeDaemonConfig(workspace, runsDir);
    mkdirSync(path.join(runsDir, 'fixture-run'), { recursive: true });
    writeFileSync(
      path.join(runsDir, 'fixture-run', 'state.json'),
      JSON.stringify({
        runId: 'fixture-run',
        specId: 'SPEC-X',
        specPath: '/tmp/spec.md',
        baseSha: 'abc',
        taskResults: {
          'T-01': {
            taskId: 'T-01',
            status: 'merged',
            prUrl:
              'https://github.com/Rosetta-Foundation/rosetta_dev-scripts/pull/0'
          }
        },
        verdicts: [],
        exceptions: [],
        criterionVerdicts: [],
        steps: {},
        tokenSpendK: 0,
        ciFixAttempts: {},
        gateFixAttempts: {},
        remediations: {},
        mergeBlockedRetries: 0,
        updatedAt: '2026-08-07T12:00:00.000Z'
      }),
      'utf-8'
    );

    const report = buildHandler().status({
      workspaceRoot: workspace,
      json: true
    });

    expect(
      report.unwatched.some(
        entry =>
          (entry.kind === 'pr-review' || entry.kind === 'pr-checks') &&
          entry.target.number === 0
      )
    ).toBe(false);
    expect(
      report.unwatched.some(
        entry =>
          entry.kind === 'run-supervisor' &&
          entry.target.runId === 'fixture-run'
      )
    ).toBe(true);
  });

  it('distinguishes a degraded watch in both table and JSON output', async () => {
    const workspace = mkdtempSync(
      path.join(os.tmpdir(), 'daemon-status-degraded-')
    );
    writeDaemonConfig(workspace);
    const store = new DaemonStoreRepository();
    const registry = new WatchRegistryService(store);
    const recorded = registry.register(workspace, {
      kind: 'pr-checks',
      target: { repo: 'owner/repo', number: 3 },
      pollSeconds: 15,
      createdBy: 'test'
    });
    for (let i = 0; i < 3; i += 1) {
      registry.recordPollFailure(
        workspace,
        recorded.id,
        new Error(`poll failed ${i + 1}`),
        3
      );
    }

    const report = buildHandler().status({
      workspaceRoot: workspace,
      json: true
    });
    expect(report.watches).toHaveLength(1);
    expect(report.watches[0]?.degraded).toBe(true);
    expect(report.watches[0]?.degradedAt).not.toBeNull();

    const lines: string[] = [];
    console.log = (message?: unknown) => {
      if (typeof message === 'string') {
        lines.push(message);
      }
    };
    buildHandler().status({ workspaceRoot: workspace, json: false });
    expect(lines.join('\n')).toMatch(/DEGRADED/);
    expect(lines.join('\n')).not.toMatch(/\[healthy\] pr-checks/);
  });

  it('shows an active watch and a consumed wake together', async () => {
    const workspace = mkdtempSync(
      path.join(os.tmpdir(), 'daemon-status-live-')
    );
    writeDaemonConfig(workspace);
    const store = new DaemonStoreRepository();
    const registry = new WatchRegistryService(store);
    registry.register(workspace, {
      kind: 'pr-review',
      target: { repo: 'owner/repo', number: 42 },
      pollSeconds: 30,
      createdBy: 'live-test'
    });
    const wake = store.writeWake(workspace, {
      kind: 'pr-review',
      target: 'pr-review:{"number":42,"repo":"owner/repo"}',
      signal: 'approved',
      createdAt: '2026-08-07T12:00:00.000Z'
    }).record;
    const claimed = await store.claimWake(workspace, wake.id);
    expect(claimed).not.toBeNull();
    store.recordWakeConsumed(workspace, wake.id, 'daemon');

    const lines: string[] = [];
    console.log = (message?: unknown) => {
      if (typeof message === 'string') {
        lines.push(message);
      }
    };
    const report = buildHandler().status({
      workspaceRoot: workspace,
      json: false
    });
    const text = lines.join('\n');
    expect(report.watches).toHaveLength(1);
    expect(report.wakes).toHaveLength(1);
    expect(report.wakes[0]?.state).toBe('consumed');
    expect(text).toMatch(/pr-review owner\/repo#42/);
    expect(text).toMatch(/consumed/);
    expect(text).toMatch(/approved/);
  });

  it('migrateWake renders a human summary and rejects bad disposition', async () => {
    const workspace = mkdtempSync(
      path.join(os.tmpdir(), 'daemon-migrate-wake-')
    );
    writeDaemonConfig(workspace);
    const migrate = jest.fn().mockResolvedValue({
      fromWakeDir: '/tmp/wake',
      workspaceRoot: workspace,
      dryRun: false,
      disposition: 'auto',
      items: [
        {
          sourceFile: '/tmp/wake/pending/a.json',
          kind: 'sdlc_escalation',
          target: 'bug-run',
          signal: 'merge-blocked',
          wakeId: 'abc',
          disposition: 'pending',
          created: true
        }
      ]
    });
    const handler = buildHandler({ migrate });
    const lines: string[] = [];
    console.log = (message?: unknown) => {
      if (typeof message === 'string') {
        lines.push(message);
      }
    };
    await handler.migrateWake({
      workspaceRoot: workspace,
      disposition: 'auto'
    });
    expect(migrate).toHaveBeenCalled();
    expect(lines.join('\n')).toMatch(/Migrated legacy wake inbox/);
    expect(lines.join('\n')).toMatch(/sdlc_escalation bug-run/);

    await expect(
      handler.migrateWake({
        workspaceRoot: workspace,
        disposition: 'nope' as 'auto'
      })
    ).rejects.toThrow(/disposition/);
  });

  it('migrateWake --json and dry-run summary paths', async () => {
    const workspace = mkdtempSync(
      path.join(os.tmpdir(), 'daemon-migrate-json-')
    );
    writeDaemonConfig(workspace);
    const report = {
      fromWakeDir: '/tmp/wake',
      workspaceRoot: workspace,
      dryRun: true,
      disposition: 'auto' as const,
      items: [
        {
          sourceFile: '/tmp/a.json',
          kind: 'pr_approve',
          target: 'Owner/repo#1',
          signal: 'approved',
          wakeId: null,
          disposition: 'dry-run' as const,
          created: false,
          detail: 'would leave as consumed'
        }
      ]
    };
    const migrate = jest.fn().mockResolvedValue(report);
    const handler = buildHandler({ migrate });

    const jsonLines: string[] = [];
    console.log = (message?: unknown) => {
      if (typeof message === 'string') {
        jsonLines.push(message);
      }
    };
    await handler.migrateWake({
      workspaceRoot: workspace,
      json: true,
      dryRun: true
    });
    expect(JSON.parse(jsonLines.join('\n'))).toMatchObject({ dryRun: true });

    const human: string[] = [];
    console.log = (message?: unknown) => {
      if (typeof message === 'string') {
        human.push(message);
      }
    };
    await handler.migrateWake({
      workspaceRoot: workspace,
      dryRun: true
    });
    expect(human.join('\n')).toMatch(/dry-run/);
  });
});
