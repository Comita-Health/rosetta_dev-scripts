import 'reflect-metadata';
import { execSync } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { Container } from 'inversify';
import os from 'os';
import path from 'path';
import { ChronicleArtifactRepository } from '../repositories/chronicle-artifact.repository';
import type { IChronicleArtifactRepository } from '../repositories/chronicle-artifact.repository';
import {
  IRunStateRepository,
  RunStateRepository
} from '../repositories/run-state.repository';
import {
  ChronicleCommitService,
  IChronicleCommitService
} from '../services/chronicle-commit.service';
import {
  GatePolicyQueryService,
  IGatePolicyQueryService
} from '../services/gate-policy-query.service';
import { WORKFLOW_TOKENS } from '../tokens';
import { RunState, SpecDocument, WorkflowError } from '../types';
import { makeEnvelope, makeTask } from './fixtures';

const SPEC: SpecDocument = {
  id: 'SPEC-PRD-0099-P2',
  prdId: 'PRD-0099',
  phase: 2,
  status: 'Approved',
  envelope: makeEnvelope(),
  tasks: [makeTask()]
};

const makeState = (): RunState => ({
  runId: 'run-1',
  specId: SPEC.id,
  specPath: '/specs/spec.md',
  baseSha: 'base-sha',
  taskResults: {
    'T-01': {
      taskId: 'T-01',
      status: 'completed',
      branch: 'sdlc/run-1/T-01',
      inputsDigest: 'impl-digest',
      recordedAt: 'x'
    }
  },
  verdicts: [
    {
      gate: 'envelope',
      taskId: 'T-01',
      outcome: 'pass',
      wouldEscalate: false,
      reasons: [],
      inputsDigest: 'env-digest',
      recordedAt: 'x'
    },
    {
      gate: 'verification',
      taskId: 'T-01',
      outcome: 'breach',
      wouldEscalate: true,
      reasons: ['failed: test: it works'],
      inputsDigest: 'ver-digest',
      evidenceIds: ['T-01-test-output'],
      recordedAt: 'x'
    }
  ],
  exceptions: [
    {
      trigger: 'reviewer-disagreement',
      taskId: 'T-01',
      context: ['disagree'],
      recordedAt: 'x'
    }
  ],
  criterionVerdicts: [],
  steps: {},
  tokenSpendK: 0,
  ciFixAttempts: {},
  updatedAt: 'x'
});

describe('ChronicleCommitService + GatePolicyQueryService (T-08)', () => {
  let ledger: string;
  let runsDir: string;
  let service: IChronicleCommitService;
  let query: IGatePolicyQueryService;
  let stateRepo: RunStateRepository;

  beforeEach(() => {
    ledger = mkdtempSync(path.join(os.tmpdir(), 'sdlc-ledger-'));
    runsDir = mkdtempSync(path.join(os.tmpdir(), 'sdlc-runs-'));
    execSync(
      'git init -q && git config user.email t@t && git config user.name t && git commit --allow-empty -q -m init',
      { cwd: ledger }
    );

    const container = new Container();
    container
      .bind<IChronicleArtifactRepository>(
        WORKFLOW_TOKENS.ChronicleArtifactRepository
      )
      .to(ChronicleArtifactRepository);
    container
      .bind<IRunStateRepository>(WORKFLOW_TOKENS.RunStateRepository)
      .to(RunStateRepository);
    container
      .bind<IChronicleCommitService>(WORKFLOW_TOKENS.ChronicleCommitService)
      .to(ChronicleCommitService);
    container
      .bind<IGatePolicyQueryService>(WORKFLOW_TOKENS.GatePolicyQueryService)
      .to(GatePolicyQueryService);
    service = container.get<IChronicleCommitService>(
      WORKFLOW_TOKENS.ChronicleCommitService
    );
    query = container.get<IGatePolicyQueryService>(
      WORKFLOW_TOKENS.GatePolicyQueryService
    );
    stateRepo = new RunStateRepository();
  });

  afterEach(() => {
    rmSync(ledger, { recursive: true, force: true });
    rmSync(runsDir, { recursive: true, force: true });
  });

  it('commits spec, task-result, verdict, and exception artifacts against versioned schemas', async () => {
    const outcome = await service.record({
      chronicleRepo: ledger,
      spec: SPEC,
      state: makeState()
    });

    expect(outcome.artifactPaths).toEqual(
      expect.arrayContaining([
        expect.stringContaining('spec.json'),
        expect.stringContaining('task-T-01.json'),
        expect.stringContaining('verdict-000-envelope.json'),
        expect.stringContaining('verdict-001-verification.json'),
        expect.stringContaining('exceptions.json')
      ])
    );

    const repo = new ChronicleArtifactRepository();
    const artifacts = repo.readArtifacts(ledger, 'run-1');
    const schemas = artifacts.map(artifact => artifact.schema);
    expect(schemas).toEqual(
      expect.arrayContaining([
        'sdlc.spec.v1',
        'sdlc.task-result.v1',
        'sdlc.verdict.v1',
        'sdlc.exceptions.v1'
      ])
    );
    // Every artifact carries the versioned envelope fields.
    for (const artifact of artifacts) {
      expect(artifact.schema).toMatch(/^sdlc\..+\.v\d+$/);
      expect(artifact.runId).toBe('run-1');
      expect(artifact.specId).toBe(SPEC.id);
      expect(artifact.recordedAt).toEqual(expect.any(String));
    }

    const message = execSync('git log -1 --format=%B', {
      cwd: ledger,
      encoding: 'utf-8'
    });
    expect(message).toContain('chronicle(sdlc): run-1 run artifacts');
  });

  it('exposes gate identity, inputs digest, outcome, and evidence refs through the gate-policy query (consumer-style)', async () => {
    await service.record({
      chronicleRepo: ledger,
      spec: SPEC,
      state: makeState()
    });

    const verdicts = query.verdicts(ledger, 'run-1');
    expect(verdicts).toHaveLength(2);
    for (const payload of verdicts) {
      expect(payload.gate).toEqual(expect.any(String));
      expect(payload.inputsDigest).toEqual(expect.any(String));
      expect(payload.outcome).toEqual(expect.any(String));
      expect(payload.taskId).toBe('T-01');
      expect(Array.isArray(payload.evidenceRefs)).toBe(true);
    }
    const verification = query.verdicts(ledger, 'run-1', 'verification');
    expect(verification).toHaveLength(1);
    expect(verification[0].evidenceRefs).toEqual(['T-01-test-output']);
    expect(verification[0].inputsDigest).toBe('ver-digest');
  });

  it('records the merged SHA on human-approved merge, in state and Chronicle', async () => {
    const state = makeState();
    stateRepo.save(runsDir, state);

    const artifactPath = await service.recordMerge({
      chronicleRepo: ledger,
      runsDir,
      runId: 'run-1',
      mergedSha: 'abc123def456'
    });

    expect(artifactPath).toContain('merge.json');
    const reloaded = stateRepo.load(runsDir, 'run-1');
    expect(reloaded?.mergedSha).toBe('abc123def456');

    const repo = new ChronicleArtifactRepository();
    const merge = repo
      .readArtifacts(ledger, 'run-1')
      .find(artifact => artifact.schema === 'sdlc.merge.v1');
    expect(merge?.payload).toEqual({
      mergedSha: 'abc123def456',
      approvedBy: 'human'
    });

    const message = execSync('git log -1 --format=%B', {
      cwd: ledger,
      encoding: 'utf-8'
    });
    expect(message).toContain('chronicle(sdlc): run-1 merged at abc123def456');
  });

  it('record-merge with a task ID also marks that task merged (P3 T-01)', async () => {
    const state = makeState();
    state.taskResults['T-01'] = {
      taskId: 'T-01',
      status: 'completed',
      recordedAt: 'x'
    };
    stateRepo.save(runsDir, state);

    await service.recordMerge({
      chronicleRepo: ledger,
      runsDir,
      runId: 'run-1',
      mergedSha: 'abc123def456',
      taskId: 'T-01'
    });

    const reloaded = stateRepo.load(runsDir, 'run-1');
    expect(reloaded?.taskResults['T-01'].mergedSha).toBe('abc123def456');

    const repo = new ChronicleArtifactRepository();
    const merge = repo
      .readArtifacts(ledger, 'run-1')
      .find(artifact => artifact.schema === 'sdlc.merge.v1');
    expect(merge?.payload).toEqual({
      mergedSha: 'abc123def456',
      approvedBy: 'human',
      taskId: 'T-01'
    });
  });

  it('rejects record-merge for an unknown run', async () => {
    await expect(
      service.recordMerge({
        chronicleRepo: ledger,
        runsDir,
        runId: 'run-unknown',
        mergedSha: 'abc'
      })
    ).rejects.toThrow(WorkflowError);
  });
});
