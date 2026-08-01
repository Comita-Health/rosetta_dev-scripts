import { execSync } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import { ChronicleArtifactRepository } from '../repositories/chronicle-artifact.repository';
import { ChronicleArtifact, WorkflowError } from '../types';

const makeArtifact = (
  overrides: Partial<ChronicleArtifact> = {}
): ChronicleArtifact => ({
  schema: 'sdlc.verdict.v1',
  runId: 'run-1',
  specId: 'SPEC-PRD-0099-P2',
  recordedAt: 'x',
  payload: { gate: 'envelope' },
  ...overrides
});

describe('ChronicleArtifactRepository (T-08, ADR-0007 commits)', () => {
  const repo = new ChronicleArtifactRepository();
  let ledger: string;

  beforeEach(() => {
    ledger = mkdtempSync(path.join(os.tmpdir(), 'sdlc-ledger-'));
    execSync(
      'git init -q && git config user.email t@t && git config user.name t && git commit --allow-empty -q -m init',
      { cwd: ledger }
    );
  });
  afterEach(() => rmSync(ledger, { recursive: true, force: true }));

  it('writes artifacts under chronicles/sdlc/<runId>/ and reads them back', () => {
    const written = repo.writeArtifact(ledger, 'run-1', 'spec', makeArtifact());
    expect(written).toBe(path.join('chronicles', 'sdlc', 'run-1', 'spec.json'));

    const artifacts = repo.readArtifacts(ledger, 'run-1');
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].schema).toBe('sdlc.verdict.v1');
  });

  it('returns [] for a run with no artifacts', () => {
    expect(repo.readArtifacts(ledger, 'run-none')).toEqual([]);
  });

  it('commits with the chronicle type, scope, and ADR-0007 trailers', () => {
    repo.writeArtifact(ledger, 'run-1', 'spec', makeArtifact());
    repo.commit(ledger, 'sdlc', 'run-1 run artifacts');

    const message = execSync('git log -1 --format=%B', {
      cwd: ledger,
      encoding: 'utf-8'
    });
    expect(message).toContain('chronicle(sdlc): run-1 run artifacts');
    expect(message).toMatch(/Chronicle-Window: \d{4}-\d{2}-\d{2}/);
    expect(message).toContain('Generated-By: sdlc-workflow@');
  });

  it('is a no-op on a clean tree (resume idempotency)', () => {
    repo.writeArtifact(ledger, 'run-1', 'spec', makeArtifact());
    repo.commit(ledger, 'sdlc', 'first');
    repo.commit(ledger, 'sdlc', 'second'); // nothing staged

    const count = execSync('git rev-list --count HEAD', {
      cwd: ledger,
      encoding: 'utf-8'
    }).trim();
    expect(count).toBe('2'); // init + first only
  });

  it('throws a WorkflowError when the ledger path is not a git repo', () => {
    const plain = mkdtempSync(path.join(os.tmpdir(), 'sdlc-plain-'));
    try {
      repo.writeArtifact(plain, 'run-1', 'spec', makeArtifact());
      expect(() => repo.commit(plain, 'sdlc', 'x')).toThrow(WorkflowError);
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });
});
