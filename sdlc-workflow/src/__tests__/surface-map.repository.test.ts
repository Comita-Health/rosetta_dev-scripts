import 'reflect-metadata';
import { execSync } from 'child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { Container } from 'inversify';
import { GitRepository } from '../repositories/git.repository';
import type { IGitRepository } from '../repositories/git.repository';
import {
  SurfaceMapRepository,
  type ISurfaceMapRepository
} from '../repositories/surface-map.repository';
import {
  EnvelopeGateService,
  IEnvelopeGateService
} from '../services/envelope-gate.service';
import { WORKFLOW_TOKENS } from '../tokens';
import { makeEnvelope } from './fixtures';

const sh = (cwd: string, cmd: string): string =>
  execSync(cmd, { cwd, encoding: 'utf-8' });

/** Commit `.sdlc/surfaces.json` with the given map in the repo at `dir`. */
const commitSurfaces = (
  dir: string,
  map: Record<string, string[]>,
  message: string
): void => {
  mkdirSync(path.join(dir, '.sdlc'), { recursive: true });
  writeFileSync(path.join(dir, '.sdlc', 'surfaces.json'), JSON.stringify(map));
  sh(dir, `git add -A && git commit -q -m "${message}"`);
};

describe('SurfaceMapRepository', () => {
  const repo = new SurfaceMapRepository(new GitRepository());
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'sdlc-surfaces-'));
    sh(
      dir,
      'git init -q && git config user.email t@t && git config user.name t && git commit --allow-empty -q -m init'
    );
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  describe('load (working tree — synthesis-time only)', () => {
    it('returns an empty map when no surfaces file exists', () => {
      expect(repo.load(dir)).toEqual({});
    });

    it('loads the surface map from .sdlc/surfaces.json', () => {
      mkdirSync(path.join(dir, '.sdlc'), { recursive: true });
      writeFileSync(
        path.join(dir, '.sdlc', 'surfaces.json'),
        JSON.stringify({ auth: ['src/auth/**'] })
      );
      expect(repo.load(dir)).toEqual({ auth: ['src/auth/**'] });
    });
  });

  describe('loadAtRef (tree under judgment — T-03)', () => {
    it('returns the committed blob, ignoring uncommitted local edits', () => {
      commitSurfaces(dir, { auth: ['src/auth/**'] }, 'add surfaces');
      // Local tampering: the working copy exonerates everything.
      writeFileSync(
        path.join(dir, '.sdlc', 'surfaces.json'),
        JSON.stringify({ auth: ['nothing/**'] })
      );

      expect(repo.loadAtRef(dir, 'HEAD')).toEqual({ auth: ['src/auth/**'] });
    });

    it('returns null when the ref carries no surfaces.json', () => {
      expect(repo.loadAtRef(dir, 'HEAD')).toBeNull();
    });
  });
});

/**
 * End-to-end acceptance tests for SPEC-BUG-envelope-spec-integrity-P1 T-03
 * against a real git repo: the envelope gate judges with the PR-tip blob of
 * `.sdlc/surfaces.json`, never the operator's (possibly tampered) checkout,
 * and a contract missing from the judged tree is a named error verdict.
 */
describe('EnvelopeGateService contract resolution (T-03, real git)', () => {
  let dir: string;
  let gate: IEnvelopeGateService;

  const makeGate = (): IEnvelopeGateService => {
    const container = new Container();
    container
      .bind<IGitRepository>(WORKFLOW_TOKENS.GitRepository)
      .to(GitRepository);
    container
      .bind<ISurfaceMapRepository>(WORKFLOW_TOKENS.SurfaceMapRepository)
      .to(SurfaceMapRepository);
    container
      .bind<IEnvelopeGateService>(WORKFLOW_TOKENS.EnvelopeGateService)
      .to(EnvelopeGateService);
    return container.get<IEnvelopeGateService>(
      WORKFLOW_TOKENS.EnvelopeGateService
    );
  };

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'sdlc-gate-tree-'));
    sh(
      dir,
      'git init -q -b main && git config user.email t@t && git config user.name t && git commit --allow-empty -q -m init'
    );
    gate = makeGate();
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('judges with the PR-tip blob; an uncommitted local surfaces.json edit has no influence', async () => {
    commitSurfaces(dir, { auth: ['src/auth/**'] }, 'chore: surfaces');
    const baseSha = sh(dir, 'git rev-parse HEAD').trim();

    // Task branch touches a path the committed contract forbids.
    sh(dir, 'git checkout -q -b sdlc/run-1/T-01');
    mkdirSync(path.join(dir, 'src', 'auth'), { recursive: true });
    writeFileSync(path.join(dir, 'src', 'auth', 'token.ts'), 'export {};\n');
    sh(dir, 'git add -A && git commit -q -m "feat: touch auth"');

    // Back on main, tamper with the local checkout so the label would
    // resolve to nothing if the gate read from disk.
    sh(dir, 'git checkout -q main');
    writeFileSync(
      path.join(dir, '.sdlc', 'surfaces.json'),
      JSON.stringify({ auth: ['nothing/**'] })
    );

    const verdict = await gate.evaluate({
      repoPath: dir,
      baseRef: baseSha,
      headRef: 'sdlc/run-1/T-01',
      envelope: makeEnvelope({
        allowedPaths: ['src/**'],
        forbiddenSurfaces: ['auth'],
        maxDiffLines: 100
      })
    });

    expect(verdict.outcome).toBe('breach');
    expect(verdict.reasons.join(' ')).toContain(
      'forbidden surface "auth" touched: src/auth/token.ts'
    );
  });

  it('names the error when the judged tree carries no contract, even though local disk has one', async () => {
    const baseSha = sh(dir, 'git rev-parse HEAD').trim();

    // Task branch never commits a surfaces.json.
    sh(dir, 'git checkout -q -b sdlc/run-1/T-02');
    mkdirSync(path.join(dir, 'src'), { recursive: true });
    writeFileSync(path.join(dir, 'src', 'a.ts'), 'export {};\n');
    sh(dir, 'git add -A && git commit -q -m "feat: add a"');

    // A contract sitting on local disk must not be used as a fallback.
    mkdirSync(path.join(dir, '.sdlc'), { recursive: true });
    writeFileSync(
      path.join(dir, '.sdlc', 'surfaces.json'),
      JSON.stringify({ auth: ['src/auth/**'] })
    );

    const verdict = await gate.evaluate({
      repoPath: dir,
      baseRef: baseSha,
      headRef: 'sdlc/run-1/T-02',
      envelope: makeEnvelope({
        allowedPaths: ['src/**'],
        forbiddenSurfaces: ['auth'],
        maxDiffLines: 100
      })
    });

    expect(verdict.outcome).toBe('breach');
    expect(verdict.wouldEscalate).toBe(true);
    expect(verdict.reasons.join(' ')).toContain(
      'surface contract .sdlc/surfaces.json missing from judged tree sdlc/run-1/T-02'
    );
  });
});
