import 'reflect-metadata';
import { Container } from 'inversify';
import type { ICiStatusRepository } from '../repositories/ci-status.repository';
import { CiGateService, ICiGateService } from '../services/ci-gate.service';
import { WORKFLOW_TOKENS } from '../tokens';

const INPUT = { repoPath: '/repo', sha: 'abc123', taskId: 'T-01' };

describe('CiGateService (real CI gate)', () => {
  let gate: ICiGateService;
  let checkRuns: jest.Mock;

  beforeEach(() => {
    checkRuns = jest.fn();
    const container = new Container();
    container
      .bind<ICiStatusRepository>(WORKFLOW_TOKENS.CiStatusRepository)
      .toConstantValue({ checkRuns });
    container
      .bind<ICiGateService>(WORKFLOW_TOKENS.CiGateService)
      .to(CiGateService);
    gate = container.get<ICiGateService>(WORKFLOW_TOKENS.CiGateService);
  });

  it('blocks honestly when the commit has no CI results (not pushed)', async () => {
    checkRuns.mockReturnValue(null);

    const verdict = await gate.evaluate(INPUT);

    expect(verdict.gate).toBe('ci');
    expect(verdict.outcome).toBe('blocked');
    expect(verdict.wouldEscalate).toBe(false);
    expect(verdict.reasons[0]).toContain('no CI results for abc123');
    expect(verdict.taskId).toBe('T-01');
    expect(verdict.inputsDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('blocks when the commit exists but reports zero check runs', async () => {
    checkRuns.mockReturnValue({ total: 0, failed: [], pending: [] });

    const verdict = await gate.evaluate(INPUT);

    expect(verdict.outcome).toBe('blocked');
    expect(verdict.reasons[0]).toContain('no check runs');
  });

  it('breaches (would escalate) on any failed check', async () => {
    checkRuns.mockReturnValue({
      total: 2,
      failed: ['ci'],
      pending: []
    });

    const verdict = await gate.evaluate(INPUT);

    expect(verdict.outcome).toBe('breach');
    expect(verdict.wouldEscalate).toBe(true);
    expect(verdict.reasons).toEqual(['check failed: ci']);
  });

  it('blocks while checks are still pending', async () => {
    checkRuns.mockReturnValue({ total: 2, failed: [], pending: ['e2e'] });

    const verdict = await gate.evaluate(INPUT);

    expect(verdict.outcome).toBe('blocked');
    expect(verdict.reasons).toEqual(['check pending: e2e']);
  });

  it('passes when every check run is green', async () => {
    checkRuns.mockReturnValue({ total: 3, failed: [], pending: [] });

    const verdict = await gate.evaluate(INPUT);

    expect(verdict.outcome).toBe('pass');
    expect(verdict.reasons).toEqual(['3 check runs green for abc123']);
  });
});
