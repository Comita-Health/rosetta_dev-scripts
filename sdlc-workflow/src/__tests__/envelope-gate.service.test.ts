import 'reflect-metadata';
import { Container } from 'inversify';
import type { IGitRepository } from '../repositories/git.repository';
import type { ISurfaceMapRepository } from '../repositories/surface-map.repository';
import {
  EnvelopeGateService,
  IEnvelopeGateService
} from '../services/envelope-gate.service';
import { WORKFLOW_TOKENS } from '../tokens';
import { DiffStat } from '../types';
import { makeEnvelope } from './fixtures';

const INPUT = {
  repoPath: '/repo',
  baseRef: 'base-sha',
  headRef: 'sdlc/run-1/T-01',
  envelope: makeEnvelope({
    allowedPaths: ['src/**'],
    forbiddenSurfaces: ['auth'],
    maxDiffLines: 100
  })
};

describe('EnvelopeGateService (T-02)', () => {
  let gate: IEnvelopeGateService;
  let diffStat: jest.Mock;
  let loadSurfaces: jest.Mock;

  const setDiff = (diff: DiffStat) => diffStat.mockReturnValue(diff);

  beforeEach(() => {
    diffStat = jest.fn();
    loadSurfaces = jest.fn().mockReturnValue({ auth: ['src/auth/**'] });

    const container = new Container();
    container
      .bind<IGitRepository>(WORKFLOW_TOKENS.GitRepository)
      .toConstantValue({
        diffStat,
        diffText: jest.fn(),
        headSha: jest.fn(),
        status: jest.fn(),
        addWorktree: jest.fn(),
        push: jest.fn(),
        fetch: jest.fn(),
        resolveSha: jest.fn(),
        defaultBranch: jest.fn(),
        fileAtRef: jest.fn().mockReturnValue(null),
        pathDiffersFromRef: jest.fn().mockReturnValue(false),
        revertMerge: jest.fn(),
        stageAll: jest.fn(),
        commit: jest.fn(),
        removeWorktreeAsync: jest.fn()
      });
    container
      .bind<ISurfaceMapRepository>(WORKFLOW_TOKENS.SurfaceMapRepository)
      .toConstantValue({ load: loadSurfaces });
    container
      .bind<IEnvelopeGateService>(WORKFLOW_TOKENS.EnvelopeGateService)
      .to(EnvelopeGateService);
    gate = container.get<IEnvelopeGateService>(
      WORKFLOW_TOKENS.EnvelopeGateService
    );
  });

  it('passes a diff confined to allowedPaths and under maxDiffLines', async () => {
    setDiff({
      files: [{ path: 'src/feature/a.ts', lines: 40 }],
      totalLines: 40
    });

    const verdict = await gate.evaluate(INPUT);

    expect(verdict).toMatchObject({
      gate: 'envelope',
      outcome: 'pass',
      wouldEscalate: false,
      reasons: []
    });
  });

  it('breaches on a path outside allowedPaths, naming the offender', async () => {
    setDiff({
      files: [
        { path: 'src/feature/a.ts', lines: 10 },
        { path: 'infra/deploy.yml', lines: 5 }
      ],
      totalLines: 15
    });

    const verdict = await gate.evaluate(INPUT);

    expect(verdict.outcome).toBe('breach');
    expect(verdict.wouldEscalate).toBe(true);
    expect(verdict.reasons.join(' ')).toContain('infra/deploy.yml');
  });

  it('breaches when a forbidden surface is touched, resolved via the surface map', async () => {
    setDiff({
      files: [{ path: 'src/auth/token.ts', lines: 8 }],
      totalLines: 8
    });

    const verdict = await gate.evaluate(INPUT);

    expect(verdict.outcome).toBe('breach');
    expect(verdict.reasons.join(' ')).toContain(
      'forbidden surface "auth" touched: src/auth/token.ts'
    );
  });

  it('breaches when the diff exceeds maxDiffLines, citing the line count', async () => {
    setDiff({
      files: [{ path: 'src/big.ts', lines: 250 }],
      totalLines: 250
    });

    const verdict = await gate.evaluate(INPUT);

    expect(verdict.outcome).toBe('breach');
    expect(verdict.reasons.join(' ')).toContain('250');
    expect(verdict.reasons.join(' ')).toContain('100');
  });

  it('reports an unresolvable surface label instead of ignoring it', async () => {
    loadSurfaces.mockReturnValue({});
    setDiff({ files: [{ path: 'src/a.ts', lines: 1 }], totalLines: 1 });

    const verdict = await gate.evaluate(INPUT);

    expect(verdict.outcome).toBe('breach');
    expect(verdict.reasons.join(' ')).toContain(
      'unresolvable surface label: auth'
    );
  });
});
