import { execFileSync } from 'child_process';
import { mkdtempSync, readdirSync } from 'fs';
import os from 'os';
import path from 'path';
import { DaemonStoreRepository } from '../repositories/daemon-store.repository';
import {
  WatchRegistryService,
  watchRegistrationId
} from '../services/watch-registry.service';
import type { WatchRegistrationInput } from '../types';

const registration: WatchRegistrationInput = {
  kind: 'pr-review',
  target: { repo: 'owner/repo', number: 42 },
  pollSeconds: 30,
  createdBy: 'pr-approve-watch'
};

const buildRegistry = (): {
  store: DaemonStoreRepository;
  registry: WatchRegistryService;
} => {
  const store = new DaemonStoreRepository();
  return { store, registry: new WatchRegistryService(store) };
};

describe('WatchRegistryService', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('reopens a registration after the registering process exits', () => {
    const workspace = mkdtempSync(
      path.join(os.tmpdir(), 'watch-registry-process-')
    );
    const servicePath = path.resolve(
      __dirname,
      '..',
      'services',
      'watch-registry.service.ts'
    );
    const storePath = path.resolve(
      __dirname,
      '..',
      'repositories',
      'daemon-store.repository.ts'
    );
    const script = `
      const { DaemonStoreRepository } = require(${JSON.stringify(storePath)});
      const { WatchRegistryService } = require(${JSON.stringify(servicePath)});
      const registry = new WatchRegistryService(new DaemonStoreRepository());
      registry.register(process.env.WORKSPACE, ${JSON.stringify(registration)});
    `;

    execFileSync(process.execPath, ['--import', 'tsx', '--eval', script], {
      cwd: path.resolve(__dirname, '..', '..'),
      env: { ...process.env, WORKSPACE: workspace }
    });

    const freshRegistry = buildRegistry().registry;
    expect(
      freshRegistry.getByTarget(
        workspace,
        registration.kind,
        registration.target
      )
    ).toMatchObject(registration);
  });

  it('deduplicates the same kind and target into one durable record', () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), 'watch-registry-id-'));
    const { store, registry } = buildRegistry();
    const first = registry.register(workspace, registration);
    const duplicate = registry.register(workspace, {
      ...registration,
      target: { number: 42, repo: 'owner/repo' },
      pollSeconds: 60
    });

    expect(duplicate).toEqual(first);
    expect(registry.list(workspace)).toHaveLength(1);
    expect(readdirSync(store.paths(workspace).watches)).toHaveLength(1);
  });

  it('never returns workspace A registrations from workspace B', () => {
    const workspaceA = mkdtempSync(path.join(os.tmpdir(), 'watch-registry-a-'));
    const workspaceB = mkdtempSync(path.join(os.tmpdir(), 'watch-registry-b-'));
    const { registry } = buildRegistry();
    const record = registry.register(workspaceA, registration);

    expect(registry.get(workspaceB, record.id)).toBeNull();
    expect(
      registry.getByTarget(workspaceB, registration.kind, registration.target)
    ).toBeNull();
    expect(registry.list(workspaceB)).toEqual([]);
  });

  it('expires a watch when its poll reports a terminal target state', () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-07T10:00:00.000Z'));
    const workspace = mkdtempSync(
      path.join(os.tmpdir(), 'watch-registry-terminal-')
    );
    const { store, registry } = buildRegistry();
    const record = registry.register(workspace, registration);

    jest.setSystemTime(new Date('2026-08-07T10:00:30.000Z'));
    const terminal = registry.recordPoll(workspace, record.id, {
      terminalState: 'merged'
    });

    expect(terminal).toMatchObject({
      lastPollTime: '2026-08-07T10:00:30.000Z',
      expiredAt: '2026-08-07T10:00:30.000Z',
      terminalState: 'merged'
    });
    expect(registry.get(workspace, record.id)).toBeNull();
    expect(registry.list(workspace)).toEqual([]);
    expect(store.readWatch(workspace, record.id)).toEqual(terminal);
    expect(registry.recordPoll(workspace, record.id)).toBeNull();
  });

  it('lists active watches with kind, target, age, and last poll time', () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-07T10:00:00.000Z'));
    const workspace = mkdtempSync(
      path.join(os.tmpdir(), 'watch-registry-list-')
    );
    const { registry } = buildRegistry();
    const record = registry.register(workspace, {
      ...registration,
      action: {
        kind: 'agent-dispatch',
        prompt: 'Triage this PR',
        transcriptDir: '.sdlc/transcripts'
      },
      expiresAt: '2026-08-07T11:00:00.000Z'
    });

    jest.setSystemTime(new Date('2026-08-07T10:00:15.000Z'));
    expect(registry.list(workspace)).toEqual([
      {
        id: record.id,
        kind: 'pr-review',
        target: { repo: 'owner/repo', number: 42 },
        pollSeconds: 30,
        action: {
          kind: 'agent-dispatch',
          prompt: 'Triage this PR',
          transcriptDir: '.sdlc/transcripts'
        },
        createdBy: 'pr-approve-watch',
        expiresAt: '2026-08-07T11:00:00.000Z',
        age: 15,
        lastPollTime: null
      }
    ]);

    registry.recordPoll(workspace, record.id);
    expect(registry.list(workspace)[0].lastPollTime).toBe(
      '2026-08-07T10:00:15.000Z'
    );
  });

  it('durably expires registrations at their declared expiry time', () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-07T10:00:00.000Z'));
    const workspace = mkdtempSync(
      path.join(os.tmpdir(), 'watch-registry-expiry-')
    );
    const { store, registry } = buildRegistry();
    const record = registry.register(workspace, {
      ...registration,
      expiresAt: '2026-08-07T10:01:00.000Z'
    });

    jest.setSystemTime(new Date('2026-08-07T10:01:00.000Z'));
    expect(registry.get(workspace, record.id)).toBeNull();
    expect(store.readWatch(workspace, record.id)).toMatchObject({
      expiredAt: '2026-08-07T10:01:00.000Z'
    });
  });

  it('supports explicit terminal expiry and re-registration', () => {
    const workspace = mkdtempSync(
      path.join(os.tmpdir(), 'watch-registry-explicit-')
    );
    const { registry } = buildRegistry();
    const original = registry.register(workspace, registration);

    expect(registry.expire(workspace, original.id, 'closed')).toMatchObject({
      terminalState: 'closed'
    });
    expect(registry.expire(workspace, original.id, 'closed')).toBeNull();
    const rearmed = registry.register(workspace, registration);
    expect(rearmed.id).toBe(original.id);
    expect(rearmed.expiredAt).toBeUndefined();
    expect(registry.list(workspace)).toHaveLength(1);
  });

  it('validates registrations before creating durable state', () => {
    const workspace = mkdtempSync(
      path.join(os.tmpdir(), 'watch-registry-invalid-')
    );
    const { store, registry } = buildRegistry();

    expect(() =>
      registry.register(workspace, { ...registration, pollSeconds: 0 })
    ).toThrow(/pollSeconds/);
    expect(() =>
      registry.register(workspace, { ...registration, createdBy: ' ' })
    ).toThrow(/createdBy/);
    expect(() =>
      registry.register(workspace, {
        ...registration,
        target: {}
      })
    ).toThrow(/identify a resource/);
    expect(() =>
      registry.register(workspace, {
        ...registration,
        target: { repo: '' }
      })
    ).toThrow(/target.repo/);
    expect(() =>
      registry.register(workspace, {
        ...registration,
        target: { number: -1 }
      })
    ).toThrow(/target.number/);
    expect(() =>
      registry.register(workspace, {
        ...registration,
        target: { runId: '' }
      })
    ).toThrow(/target.runId/);
    expect(() =>
      registry.register(workspace, {
        ...registration,
        expiresAt: 'not-a-date'
      })
    ).toThrow(/expiresAt/);
    expect(() =>
      registry.register(workspace, {
        ...registration,
        action: {
          kind: 'engine-command',
          argv: ['status'],
          transcriptDir: ''
        }
      })
    ).toThrow(/action.transcriptDir/);
    expect(store.listWatches(workspace)).toEqual([]);
  });

  it('rejects invalid targets when deriving an identity', () => {
    expect(() =>
      watchRegistrationId('pr-review', null as unknown as {})
    ).toThrow(/target must be an object/);
  });
});
