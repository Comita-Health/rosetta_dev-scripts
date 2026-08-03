import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { ContractRepository } from '../repositories/contract.repository';
import { EvidenceRepository } from '../repositories/evidence.repository';
import { ShellCommandRepository } from '../repositories/shell-command.repository';

describe('ContractRepository', () => {
  const repo = new ContractRepository();
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'sdlc-contract-'));
    mkdirSync(path.join(dir, '.sdlc'), { recursive: true });
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const writeEnvironments = (value: unknown): void =>
    writeFileSync(
      path.join(dir, '.sdlc', 'environments.json'),
      typeof value === 'string' ? value : JSON.stringify(value)
    );

  it('loads the sandbox contract with a default timeout', () => {
    writeEnvironments({
      sandbox: { deployCommand: './deploy.sh', healthCommand: './health.sh' }
    });

    expect(repo.loadSandbox(dir)).toEqual({
      deployCommand: './deploy.sh',
      healthCommand: './health.sh',
      timeoutMinutes: 45
    });
  });

  it('honours an explicit timeout', () => {
    writeEnvironments({
      sandbox: {
        deployCommand: 'd',
        healthCommand: 'h',
        timeoutMinutes: 10
      }
    });
    expect(repo.loadSandbox(dir)?.timeoutMinutes).toBe(10);
  });

  it('exposes only the sandbox entry of a full environment configuration', () => {
    writeEnvironments({
      sandbox: { deployCommand: 'd', healthCommand: 'h' },
      production: { deployCommand: './deploy-to-PRODUCTION.sh' }
    });

    const contract = repo.loadSandbox(dir);
    expect(contract?.deployCommand).toBe('d');
    // There is no API surface returning any other environment.
    const api = Object.getOwnPropertyNames(ContractRepository.prototype);
    expect(api.sort()).toEqual(
      ['constructor', 'loadSandbox', 'loadVerification'].sort()
    );
  });

  it('returns null when the file or sandbox entry is missing', () => {
    expect(repo.loadSandbox(dir)).toBeNull();
    writeEnvironments({ production: { deployCommand: 'x' } });
    expect(repo.loadSandbox(dir)).toBeNull();
  });

  it('rejects a sandbox entry missing its commands', () => {
    writeEnvironments({ sandbox: { deployCommand: 'd' } });
    expect(() => repo.loadSandbox(dir)).toThrow(
      expect.objectContaining({ code: 'CONTRACT_MALFORMED' })
    );
  });

  it('rejects malformed JSON with a typed error', () => {
    writeEnvironments('{not json');
    expect(() => repo.loadSandbox(dir)).toThrow(
      expect.objectContaining({ code: 'CONTRACT_MALFORMED' })
    );
  });

  it('loads and validates the verification contract', () => {
    expect(repo.loadVerification(dir)).toBeNull();

    writeFileSync(
      path.join(dir, '.sdlc', 'verification.json'),
      JSON.stringify({ testCommand: 'bun test' })
    );
    expect(repo.loadVerification(dir)).toEqual({ testCommand: 'bun test' });

    writeFileSync(
      path.join(dir, '.sdlc', 'verification.json'),
      JSON.stringify({ nope: true })
    );
    expect(() => repo.loadVerification(dir)).toThrow(
      expect.objectContaining({ code: 'CONTRACT_MALFORMED' })
    );
  });
});

describe('ShellCommandRepository', () => {
  const repo = new ShellCommandRepository();

  it('runs a command and captures output', async () => {
    const result = await repo.run(
      os.tmpdir(),
      'echo "hello $SDLC_SANDBOX_SHA"',
      {
        SDLC_SANDBOX_SHA: 'abc123'
      },
      10_000
    );
    expect(result.ok).toBe(true);
    expect(result.output).toContain('hello abc123');
  });

  it('reports failure with combined output on non-zero exit', async () => {
    const result = await repo.run(
      os.tmpdir(),
      'echo out; echo err >&2; exit 3',
      {},
      10_000
    );
    expect(result.ok).toBe(false);
    expect(result.output).toContain('out');
    expect(result.output).toContain('err');
  });

  it('fails when the command exceeds the timeout', async () => {
    const result = await repo.run(os.tmpdir(), 'sleep 2', {}, 200);
    expect(result.ok).toBe(false);
  });

  it('runs two commands concurrently rather than blocking the event loop', async () => {
    const start = Date.now();
    await Promise.all([
      repo.run(os.tmpdir(), 'sleep 0.3', {}, 5_000),
      repo.run(os.tmpdir(), 'sleep 0.3', {}, 5_000)
    ]);
    // Sequential (spawnSync) would take ~600ms; concurrent (spawn) ~300ms.
    expect(Date.now() - start).toBeLessThan(550);
  });
});

describe('EvidenceRepository', () => {
  const repo = new EvidenceRepository();
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'sdlc-evidence-'));
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('saves and loads an artifact by stable ID', () => {
    const file = repo.save(dir, 'run-1', 'T-01-test-output', 'all green');

    expect(file).toBe(
      path.join(dir, 'run-1', 'evidence', 'T-01-test-output.txt')
    );
    expect(repo.load(dir, 'run-1', 'T-01-test-output')).toBe('all green');
  });

  it('returns null for a missing artifact', () => {
    expect(repo.load(dir, 'run-1', 'nope')).toBeNull();
  });
});
