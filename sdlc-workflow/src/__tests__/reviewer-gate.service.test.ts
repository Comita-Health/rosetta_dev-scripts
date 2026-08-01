import 'reflect-metadata';
import { Container } from 'inversify';
import type { IGitRepository } from '../repositories/git.repository';
import type { IInferenceRepository } from '../repositories/inference.repository';
import {
  IReviewerGateService,
  ReviewerGateService
} from '../services/reviewer-gate.service';
import { WORKFLOW_TOKENS } from '../tokens';
import { buildReviewerPrompt } from '../utils/reviewer-prompt';
import { makeEnvelope, makeTask } from './fixtures';

const INPUT = {
  repoPath: '/repo',
  baseRef: 'base-sha',
  headRef: 'sdlc/run-1/T-01',
  task: makeTask(),
  envelope: makeEnvelope()
};

const DIFF = 'diff --git a/src/a.ts b/src/a.ts\n+added line';

describe('ReviewerGateService (T-05)', () => {
  let gate: IReviewerGateService;
  let diffText: jest.Mock;
  let generateJson: jest.Mock;

  beforeEach(() => {
    diffText = jest.fn().mockReturnValue(DIFF);
    generateJson = jest
      .fn()
      .mockResolvedValue({ decision: 'concur', reasons: ['looks solid'] });

    const container = new Container();
    container
      .bind<IGitRepository>(WORKFLOW_TOKENS.GitRepository)
      .toConstantValue({
        diffText,
        diffStat: jest.fn(),
        headSha: jest.fn(),
        status: jest.fn(),
        addWorktree: jest.fn(),
        push: jest.fn(),
        fetch: jest.fn(),
        resolveSha: jest.fn(),
        defaultBranch: jest.fn(),
        revertMerge: jest.fn()
      });
    container
      .bind<IInferenceRepository>(WORKFLOW_TOKENS.InferenceRepository)
      .toConstantValue({ generateJson });
    container
      .bind<IReviewerGateService>(WORKFLOW_TOKENS.ReviewerGateService)
      .to(ReviewerGateService);
    gate = container.get<IReviewerGateService>(
      WORKFLOW_TOKENS.ReviewerGateService
    );
  });

  it('builds the prompt from exactly the diff, task, and envelope — no implementation-agent state', async () => {
    await gate.review(INPUT);

    const prompt = generateJson.mock.calls[0][0];
    // Structural independence: the payload is a pure function of the three
    // review inputs and nothing else.
    expect(prompt).toBe(buildReviewerPrompt(INPUT.task, INPUT.envelope, DIFF));
    expect(prompt).toContain(DIFF);
    expect(prompt).toContain(INPUT.task.title);
    expect(prompt).toContain(INPUT.envelope.allowedPaths[0]);
  });

  it('returns a pass verdict with transcript on concur', async () => {
    const verdict = await gate.review(INPUT);

    expect(verdict).toMatchObject({
      gate: 'reviewer',
      outcome: 'pass',
      wouldEscalate: false,
      reasons: ['looks solid']
    });
    expect(verdict.transcript).toContain('concur');
  });

  it('records disagreement as a would-escalate breach with cited reasons', async () => {
    generateJson.mockResolvedValue({
      decision: 'disagree',
      reasons: ['touches auth surface', 'no test for edge case']
    });

    const verdict = await gate.review(INPUT);

    expect(verdict).toMatchObject({
      gate: 'reviewer',
      outcome: 'breach',
      wouldEscalate: true,
      reasons: ['touches auth surface', 'no test for edge case']
    });
    expect(verdict.transcript).toContain('disagree');
    expect(verdict.transcript).toContain('touches auth surface');
  });

  it('constrains the assessment to the decision enum via schema', async () => {
    await gate.review(INPUT);

    const schema = generateJson.mock.calls[0][1];
    expect(schema.properties.decision.enum).toEqual(['concur', 'disagree']);
    expect(schema.required).toEqual(['decision', 'reasons']);
  });
});
