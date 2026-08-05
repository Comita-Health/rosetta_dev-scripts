import 'reflect-metadata';
import { Container } from 'inversify';
import type { IGitRepository } from '../repositories/git.repository';
import type { IInferenceRepository } from '../repositories/inference.repository';
import type { IReviewChecklistRepository } from '../repositories/review-checklist.repository';
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
  let loadAtRef: jest.Mock;

  beforeEach(() => {
    diffText = jest.fn().mockReturnValue(DIFF);
    generateJson = jest
      .fn()
      .mockResolvedValue({ decision: 'concur', reasons: ['looks solid'] });
    // No checklist by default — the pre-checklist no-regression baseline.
    loadAtRef = jest.fn().mockReturnValue(null);

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
        treeSha: jest.fn(),
        defaultBranch: jest.fn(),
        fileAtRef: jest.fn(),
        pathDiffersFromRef: jest.fn(),
        revertMerge: jest.fn(),
        stageAll: jest.fn(),
        commit: jest.fn(),
        listFiles: jest.fn().mockReturnValue([]),
        removeWorktreeAsync: jest.fn()
      });
    container
      .bind<IInferenceRepository>(WORKFLOW_TOKENS.InferenceRepository)
      .toConstantValue({ generateJson });
    container
      .bind<IReviewChecklistRepository>(
        WORKFLOW_TOKENS.ReviewChecklistRepository
      )
      .toConstantValue({ loadAtRef });
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
    // No regression (T-01): no checklist declared → no checklist section.
    expect(prompt).not.toContain('Repo review checklist');
    expect(loadAtRef).toHaveBeenCalledWith('/repo', 'sdlc/run-1/T-01');
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
    // No regression (T-01): pre-checklist verdict shape, no extra key.
    expect(verdict).not.toHaveProperty('checklistFindings');
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
    expect(schema.properties.checklistFindings).toBeUndefined();
  });

  // SPEC-BUG-reviewer-house-bar-P1 T-01
  describe('with a checklist declared at headRef', () => {
    const CHECKLIST = {
      items: [
        { text: 'Every new HSR class has TSDoc', mandatory: true },
        { text: 'Prefer readability over cleverness', mandatory: false }
      ]
    };

    it('includes checklist items in the prompt and adds checklistFindings to the schema', async () => {
      loadAtRef.mockReturnValue(CHECKLIST);
      await gate.review(INPUT);

      const prompt = generateJson.mock.calls[0][0];
      expect(prompt).toContain('Repo review checklist');
      expect(prompt).toContain('Every new HSR class has TSDoc');
      expect(prompt).toContain('(mandatory)');

      const schema = generateJson.mock.calls[0][1];
      expect(schema.required).toContain('checklistFindings');
      expect(schema.properties.checklistFindings).toMatchObject({
        type: 'array',
        minItems: 2
      });
    });

    it('treats a concur alongside a failed mandatory item as disagree, carrying per-item findings', async () => {
      loadAtRef.mockReturnValue(CHECKLIST);
      generateJson.mockResolvedValue({
        decision: 'concur',
        reasons: ['looks solid otherwise'],
        checklistFindings: [
          {
            itemIndex: 1,
            item: 'Every new HSR class has TSDoc',
            outcome: 'fail',
            rationale: 'new UsageService has no TSDoc'
          },
          {
            itemIndex: 2,
            item: 'Prefer readability over cleverness',
            outcome: 'pass'
          }
        ]
      });

      const verdict = await gate.review(INPUT);

      expect(verdict.outcome).toBe('breach');
      expect(verdict.wouldEscalate).toBe(true);
      expect(verdict.reasons.join(' ')).toContain(
        'mandatory checklist item failed: Every new HSR class has TSDoc'
      );
      expect(verdict.checklistFindings).toHaveLength(2);
    });

    it('propagates a malformed checklist as a named error, not a silent pass-through', async () => {
      loadAtRef.mockImplementation(() => {
        throw Object.assign(new Error('no checkbox items'), {
          code: 'CONTRACT_MALFORMED'
        });
      });

      await expect(gate.review(INPUT)).rejects.toMatchObject({
        code: 'CONTRACT_MALFORMED'
      });
      expect(generateJson).not.toHaveBeenCalled();
    });
  });
});
