import 'reflect-metadata';
import { Container } from 'inversify';
import type { IAgentRunnerRepository } from '../repositories/agent-runner.repository';
import type { IContractRepository } from '../repositories/contract.repository';
import type { IEvidenceRepository } from '../repositories/evidence.repository';
import type { IShellCommandRepository } from '../repositories/shell-command.repository';
import {
  IVerificationService,
  VerificationService
} from '../services/verification.service';
import { WORKFLOW_TOKENS } from '../tokens';
import { SpecTask } from '../types';
import { makeTask } from './fixtures';

const baseInput = {
  worktreePath: '/wt',
  runsDir: '/runs',
  runId: 'run-1'
};

const taskWith = (criteria: string[]): SpecTask => ({
  ...makeTask(),
  acceptanceCriteria: criteria
});

describe('VerificationService (T-04)', () => {
  let service: IVerificationService;
  let loadVerification: jest.Mock;
  let run: jest.Mock;
  let agentRun: jest.Mock;
  let saveEvidence: jest.Mock;

  beforeEach(() => {
    loadVerification = jest.fn().mockReturnValue({ testCommand: 'bun test' });
    run = jest.fn().mockReturnValue({ ok: true, output: '12 tests passed' });
    agentRun = jest.fn().mockResolvedValue({
      ok: true,
      output:
        'probed the sandbox\n```json\n{ "pass": true, "notes": ["ok"] }\n```'
    });
    saveEvidence = jest.fn().mockReturnValue('/runs/run-1/evidence/x.txt');

    const container = new Container();
    container
      .bind<IContractRepository>(WORKFLOW_TOKENS.ContractRepository)
      .toConstantValue({ loadSandbox: jest.fn(), loadVerification });
    container
      .bind<IShellCommandRepository>(WORKFLOW_TOKENS.ShellCommandRepository)
      .toConstantValue({ run });
    container
      .bind<IAgentRunnerRepository>(WORKFLOW_TOKENS.AgentRunnerRepository)
      .toConstantValue({ run: agentRun });
    container
      .bind<IEvidenceRepository>(WORKFLOW_TOKENS.EvidenceRepository)
      .toConstantValue({ save: saveEvidence, load: jest.fn() });
    container
      .bind<IVerificationService>(WORKFLOW_TOKENS.VerificationService)
      .to(VerificationService);
    service = container.get<IVerificationService>(
      WORKFLOW_TOKENS.VerificationService
    );
  });

  it('fails spec validation on an unknown tier prefix before any execution', async () => {
    const task = taskWith(['test: fine', 'wat: no such tier']);

    await expect(service.verify({ ...baseInput, task })).rejects.toMatchObject({
      code: 'SPEC_MALFORMED'
    });
    expect(run).not.toHaveBeenCalled();
    expect(agentRun).not.toHaveBeenCalled();
    expect(saveEvidence).not.toHaveBeenCalled();
  });

  it('runs the scripted check for test-tier criteria and records per-criterion verdicts with captured output', async () => {
    const task = taskWith(['test: alpha', 'test: beta']);

    const outcome = await service.verify({ ...baseInput, task });

    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(
      '/wt',
      'bun test',
      { SDLC_TASK_ID: task.id },
      expect.any(Number)
    );
    expect(saveEvidence).toHaveBeenCalledWith(
      '/runs',
      'run-1',
      `${task.id}-test-output`,
      '12 tests passed'
    );
    expect(outcome.criteria).toHaveLength(2);
    for (const verdict of outcome.criteria) {
      expect(verdict).toMatchObject({
        tier: 'test',
        outcome: 'pass',
        evidenceId: `${task.id}-test-output`
      });
    }
    expect(outcome.verdict).toMatchObject({
      gate: 'verification',
      outcome: 'pass'
    });
  });

  it('records failing test-tier criteria when the scripted check fails', async () => {
    run.mockReturnValue({ ok: false, output: '1 test failed' });
    const task = taskWith(['test: alpha']);

    const outcome = await service.verify({ ...baseInput, task });

    expect(outcome.criteria[0].outcome).toBe('fail');
    expect(outcome.verdict).toMatchObject({
      outcome: 'breach',
      wouldEscalate: true
    });
    expect(outcome.verdict.reasons[0]).toContain('test: alpha');
  });

  it('collapses multiple failing test-tier criteria into one reason, since they share one scripted-check run', async () => {
    run.mockReturnValue({ ok: false, output: '1 test failed' });
    const task = taskWith(['test: alpha', 'test: beta', 'test: gamma']);

    const outcome = await service.verify({ ...baseInput, task });

    // One shared evidence artifact, one command run — reporting three
    // separate "failed: X" reasons would misrepresent one root cause as
    // three independent assertions.
    expect(outcome.verdict.reasons).toHaveLength(1);
    expect(outcome.verdict.reasons[0]).toContain('1 shared check');
    expect(outcome.verdict.reasons[0]).toContain(`${task.id}-test-output`);
    expect(outcome.verdict.reasons[0]).toContain('covers 3 criteria');
    expect(outcome.verdict.reasons[0]).toContain('test: alpha');
    expect(outcome.verdict.reasons[0]).toContain('test: beta');
    expect(outcome.verdict.reasons[0]).toContain('test: gamma');
  });

  it('reports agent-tier failures individually even alongside a failing shared test-tier check', async () => {
    run.mockReturnValue({ ok: false, output: 'boom' });
    agentRun.mockResolvedValue({ ok: true, output: '{ "pass": false }' });
    const task = taskWith(['test: alpha', 'test: beta', 'agent: gamma']);

    const outcome = await service.verify({ ...baseInput, task });

    // Two reasons: one collapsed test-tier group, one standalone agent-tier
    // criterion — agent-tier criteria each get their own evidenceId, so
    // they never collapse with each other or with the test-tier group.
    expect(outcome.verdict.reasons).toHaveLength(2);
    expect(
      outcome.verdict.reasons.some(
        reason => reason.includes('1 shared check') && reason.includes('test: alpha')
      )
    ).toBe(true);
    expect(
      outcome.verdict.reasons.some(reason => reason === 'failed: agent: gamma')
    ).toBe(true);
  });

  it('hands agent-tier criteria to the verifier with the sandbox health report and attaches the transcript as evidence', async () => {
    const task = taskWith(['agent: the sandbox serves the new endpoint']);

    const outcome = await service.verify({
      ...baseInput,
      task,
      healthReport: 'sha=abc healthy'
    });

    const prompt = agentRun.mock.calls[0][1];
    expect(agentRun).toHaveBeenCalledWith('/wt', expect.any(String));
    expect(prompt).toContain('the sandbox serves the new endpoint');
    expect(prompt).toContain('sha=abc healthy');
    // Independence: nothing from an implementation agent appears — the
    // prompt is built from the criterion, task heading, and health report.
    expect(prompt).toContain('no context beyond');

    expect(saveEvidence).toHaveBeenCalledWith(
      '/runs',
      'run-1',
      `${task.id}-agent-criterion-1`,
      expect.stringContaining('probed the sandbox')
    );
    expect(outcome.criteria[0]).toMatchObject({
      tier: 'agent',
      outcome: 'pass',
      evidenceId: `${task.id}-agent-criterion-1`
    });
  });

  it('fails an agent-tier criterion whose verdict cannot be parsed, keeping the transcript', async () => {
    agentRun.mockResolvedValue({ ok: true, output: 'no json here' });
    const task = taskWith(['agent: something']);

    const outcome = await service.verify({ ...baseInput, task });

    expect(outcome.criteria[0].outcome).toBe('fail');
    // The transcript keeps the raw output plus the parse failure note.
    expect(saveEvidence).toHaveBeenCalledWith(
      '/runs',
      'run-1',
      expect.any(String),
      expect.stringContaining('no json here')
    );
  });

  it('fails an agent-tier criterion when the verifier agent errors', async () => {
    agentRun.mockRejectedValue(new Error('agent could not start'));
    const task = taskWith(['agent: something']);

    const outcome = await service.verify({ ...baseInput, task });

    expect(outcome.criteria[0].outcome).toBe('fail');
    expect(saveEvidence).toHaveBeenCalledWith(
      '/runs',
      'run-1',
      expect.any(String),
      expect.stringContaining('agent could not start')
    );
  });

  it('forces the aggregate into a human-required state for manual-tier criteria', async () => {
    const task = taskWith(['test: alpha', 'manual: a human signs this off']);

    const outcome = await service.verify({ ...baseInput, task });

    const manual = outcome.criteria.find(v => v.tier === 'manual');
    expect(manual).toMatchObject({ outcome: 'human-required' });
    expect(outcome.verdict.outcome).toBe('human-required');
    // Escalates: human-required blocks the merge just like a failure, so it
    // must reach the exception ledger rather than stalling the task silently.
    expect(outcome.verdict.wouldEscalate).toBe(true);
    expect(outcome.verdict.reasons[0]).toContain('human required');
  });

  it('is green only when every criterion verdict is green', async () => {
    run.mockReturnValue({ ok: false, output: 'boom' });
    const task = taskWith(['test: alpha', 'agent: beta']);

    const outcome = await service.verify({ ...baseInput, task });

    // agent passed, test failed → breach dominates
    expect(outcome.verdict.outcome).toBe('breach');
  });

  it('degrades test-tier criteria to human-required when no verification contract exists', async () => {
    loadVerification.mockReturnValue(null);
    const task = taskWith(['test: alpha']);

    const outcome = await service.verify({ ...baseInput, task });

    expect(run).not.toHaveBeenCalled();
    expect(outcome.criteria[0].outcome).toBe('human-required');
    expect(outcome.verdict.outcome).toBe('human-required');
  });

  describe('verifyTestTierOnly (concurrent with sandbox deploy)', () => {
    it('runs only the test-tier scripted check, independent of any sandbox health report', async () => {
      const task = taskWith(['test: alpha', 'agent: beta']);

      const verdicts = await service.verifyTestTierOnly({ ...baseInput, task });

      expect(run).toHaveBeenCalledTimes(1);
      expect(agentRun).not.toHaveBeenCalled();
      expect(verdicts).toHaveLength(1);
      expect(verdicts?.[0]).toMatchObject({ tier: 'test', outcome: 'pass' });
    });

    it('returns an empty array when the task has no test-tier criteria', async () => {
      const task = taskWith(['agent: beta']);

      const verdicts = await service.verifyTestTierOnly({ ...baseInput, task });

      expect(run).not.toHaveBeenCalled();
      expect(verdicts).toEqual([]);
    });

    it('returns undefined on malformed criteria instead of throwing, deferring to verify()', async () => {
      const task = taskWith(['wat: no such tier']);

      const verdicts = await service.verifyTestTierOnly({ ...baseInput, task });

      expect(verdicts).toBeUndefined();
      expect(run).not.toHaveBeenCalled();
    });
  });

  describe('verify() with a precomputed test tier', () => {
    it('reuses precomputed test-tier verdicts instead of re-running the scripted check', async () => {
      const task = taskWith(['test: alpha']);
      const precomputedTestTier = [
        {
          taskId: task.id,
          criterion: 'test: alpha',
          tier: 'test' as const,
          outcome: 'pass' as const,
          evidenceId: 'precomputed-evidence',
          recordedAt: 'x'
        }
      ];

      const outcome = await service.verify({
        ...baseInput,
        task,
        precomputedTestTier
      });

      expect(run).not.toHaveBeenCalled();
      expect(outcome.criteria).toEqual(precomputedTestTier);
      expect(outcome.verdict.outcome).toBe('pass');
    });
  });
});
