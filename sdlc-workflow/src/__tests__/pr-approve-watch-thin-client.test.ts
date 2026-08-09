import { createHash } from 'crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync
} from 'fs';
import { Container } from 'inversify';
import os from 'os';
import path from 'path';
import {
  DaemonHandler,
  PR_WATCH_KINDS,
  parsePrWatchTarget
} from '../handlers/daemon.handler';
import { DaemonConfigRepository } from '../repositories/daemon-config.repository';
import { DaemonStoreRepository } from '../repositories/daemon-store.repository';
import { KnownWatchTargetRepository } from '../repositories/known-watch-target.repository';
import { DaemonStatusService } from '../services/daemon-status.service';
import { WatchRegistryService } from '../services/watch-registry.service';
import { WORKFLOW_TOKENS } from '../tokens';
import { WorkflowError } from '../types';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const CURSOR_SKILL = path.join(
  REPO_ROOT,
  'team-setup/templates/root/.cursor/skills/pr-approve-watch'
);
const CLAUDE_SKILL = path.join(
  REPO_ROOT,
  'team-setup/templates/root/.claude/skills/pr-approve-watch'
);

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

const buildHandler = (): DaemonHandler => {
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
    migrate: jest.fn()
  });
  container.bind(WORKFLOW_TOKENS.DaemonHandler).to(DaemonHandler);
  return container.get(WORKFLOW_TOKENS.DaemonHandler);
};

const listFilesRecursive = (root: string): string[] => {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else {
        out.push(path.relative(root, full));
      }
    }
  };
  walk(root);
  return out.sort();
};

const sha256 = (file: string): string =>
  createHash('sha256').update(readFileSync(file)).digest('hex');

/**
 * SPEC-PRD-0020-P1 T-08: pr-approve-watch becomes a thin daemon client.
 */
describe('pr-approve-watch thin daemon client (SPEC-PRD-0020-P1 T-08)', () => {
  const originalLog = console.log;

  afterEach(() => {
    console.log = originalLog;
  });

  it('skill script has no long-lived polling loop and registers via daemon watch', () => {
    const scriptPath = path.join(CURSOR_SKILL, 'scripts/watch-pr-approve.sh');
    expect(existsSync(scriptPath)).toBe(true);
    const source = readFileSync(scriptPath, 'utf-8');

    // No sleep-based poll loop; arming must exit after register+status.
    expect(source).not.toMatch(/\bsleep\s+["'$]/);
    expect(source).not.toMatch(/while\s+\[\[\s*"\$REMAINING"/);
    expect(source).not.toMatch(
      /classify_review_signal|count_reviews|maybe_reactivate/
    );

    expect(source).toMatch(/daemon watch/);
    expect(source).toMatch(/--kind pr-review/);
    expect(source).toMatch(/daemon status/);
    expect(source).toMatch(/this client exits|armed; polling is the daemon/);
  });

  it('keeps .cursor and .claude skill template trees content-identical', () => {
    expect(existsSync(CURSOR_SKILL)).toBe(true);
    expect(existsSync(CLAUDE_SKILL)).toBe(true);

    const cursorFiles = listFilesRecursive(CURSOR_SKILL);
    const claudeFiles = listFilesRecursive(CLAUDE_SKILL);
    expect(cursorFiles).toEqual(claudeFiles);

    for (const rel of cursorFiles) {
      expect(sha256(path.join(CURSOR_SKILL, rel))).toBe(
        sha256(path.join(CLAUDE_SKILL, rel))
      );
    }
  });

  it('daemon watch registers a pr-review watch and returns without polling', () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), 'daemon-watch-'));
    writeDaemonConfig(workspace);
    const handler = buildHandler();
    console.log = jest.fn();

    const records = handler.watch({
      workspaceRoot: workspace,
      kind: 'pr-review',
      targets: ['Owner/Repo#42'],
      createdBy: 'pr-approve-watch',
      pollSeconds: 15,
      json: true
    });

    expect(records).toHaveLength(1);
    expect(records[0]?.kind).toBe('pr-review');
    expect(records[0]?.target).toEqual({ repo: 'owner/repo', number: 42 });
    expect(records[0]?.createdBy).toBe('pr-approve-watch');
    expect(records[0]?.pollSeconds).toBe(15);

    const listed = new WatchRegistryService(new DaemonStoreRepository()).list(
      workspace
    );
    expect(listed).toHaveLength(1);
    expect(listed[0]?.kind).toBe('pr-review');
  });

  it('daemon watch rejects malformed targets and missing workspace', () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), 'daemon-watch-bad-'));
    writeDaemonConfig(workspace);
    const handler = buildHandler();
    console.log = jest.fn();

    expect(() =>
      handler.watch({
        workspaceRoot: undefined,
        kind: 'pr-review',
        targets: ['Owner/Repo#1']
      })
    ).toThrow(WorkflowError);

    expect(() =>
      handler.watch({
        workspaceRoot: workspace,
        kind: 'pr-review',
        targets: []
      })
    ).toThrow(/at least one/);

    expect(() =>
      handler.watch({
        workspaceRoot: workspace,
        kind: 'pr-review',
        targets: ['not-a-target']
      })
    ).toThrow(/owner\/repo#N/);

    expect(parsePrWatchTarget('Acme/app#9')).toEqual({
      repo: 'Acme/app',
      number: 9
    });
  });

  // Every target on this command is parsed as owner/repo#N, so the command may
  // only advertise kinds that actually use that grammar. Offering a run-id kind
  // here would register it under the wrong target shape.
  it('registers only the owner/repo#N kinds and rejects the rest', () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), 'daemon-watch-kind-'));
    writeDaemonConfig(workspace);
    const handler = buildHandler();
    console.log = jest.fn();

    expect(PR_WATCH_KINDS).toEqual(['pr-review', 'pr-checks', 'issue-state']);

    for (const kind of PR_WATCH_KINDS) {
      const records = handler.watch({
        workspaceRoot: workspace,
        kind,
        targets: ['Owner/Repo#7'],
        json: true
      });
      expect(records[0]?.kind).toBe(kind);
    }

    for (const kind of [
      'workflow-run',
      'run-supervisor',
      'queue-item',
      'not-a-kind'
    ]) {
      expect(() =>
        handler.watch({
          workspaceRoot: workspace,
          kind,
          targets: ['Owner/Repo#8']
        })
      ).toThrow(/--kind must be one of pr-review, pr-checks, issue-state/);
    }

    // Rejected kinds must leave no registration behind.
    const listed = new WatchRegistryService(new DaemonStoreRepository()).list(
      workspace
    );
    expect(listed.map(watch => watch.kind).sort()).toEqual([
      'issue-state',
      'pr-checks',
      'pr-review'
    ]);
  });

  // T-08 moves the transport only: the operator-facing wake contract in
  // SKILL.md must still read exactly as it did before the daemon absorbed it.
  it('keeps the documented Approve / Request-changes contract unchanged', () => {
    for (const skill of [CURSOR_SKILL, CLAUDE_SKILL]) {
      const doc = readFileSync(path.join(skill, 'SKILL.md'), 'utf-8');

      expect(doc).toContain(
        '| **Approve** | Once | Triage comments; merge only if GHA ' +
          'merge-on-approve is **not** enabled |'
      );
      expect(doc).toContain(
        '| **Request changes** | Once per new human review id | Fix / reply ' +
          '/ push — **do not merge**; keep watching |'
      );
      expect(doc).toContain('Fix the feedback and keep watching.');
      expect(doc).toContain('it keeps the target until Approve');
    }
  });
});
