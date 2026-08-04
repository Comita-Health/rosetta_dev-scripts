import 'reflect-metadata';
import { Container } from 'inversify';
import {
  IWorkflowHandler,
  WorkflowHandler
} from '../handlers/workflow.handler';
import { IPrdRepository } from '../repositories/prd.repository';
import { ISpecFileRepository } from '../repositories/spec-file.repository';
import { IDecomposeService } from '../services/decompose.service';
import { ISpecSynthesisService } from '../services/spec-synthesis.service';
import { WORKFLOW_TOKENS } from '../tokens';
import { WorkflowError, WorkflowInput } from '../types';
import { makeEnvelope, makeStory, makeTask } from './fixtures';

const INPUT: WorkflowInput = {
  prdId: 'PRD-0099',
  repoPath: '/tmp/target-repo',
  docsDir: '/tmp/docs',
  phase: 1,
  budgetK: 200
};

describe('WorkflowHandler', () => {
  let container: Container;
  let handler: IWorkflowHandler;
  let getPrd: jest.Mock;
  let decompose: jest.Mock;
  let synthesize: jest.Mock;
  let writeSpec: jest.Mock;
  let logSpy: jest.SpyInstance;

  beforeEach(() => {
    getPrd = jest.fn().mockResolvedValue({
      id: 'PRD-0099',
      title: 'Test Capability',
      status: 'Proposed',
      owner: 'Russ Watson',
      goals: ['g'],
      nonGoals: [],
      acceptanceCriteria: [],
      rolloutPhases: [{ number: 1, title: 'Walk', description: 'd' }]
    });
    decompose = jest.fn().mockResolvedValue([makeStory()]);
    synthesize = jest.fn().mockResolvedValue({
      specId: 'SPEC-PRD-0099-P1',
      prdId: 'PRD-0099',
      phase: 1,
      summary: 's',
      context: 'c',
      tasks: [makeTask()],
      envelope: makeEnvelope(),
      markdown: '---\nstatus: Draft\n---\n# spec',
      warnings: []
    });
    writeSpec = jest
      .fn()
      .mockReturnValue('/tmp/target-repo/specs/PRD-0099/phase-1-spec.md');

    container = new Container();
    container
      .bind<IPrdRepository>(WORKFLOW_TOKENS.PrdRepository)
      .toConstantValue({ getPrd });
    container
      .bind<ISpecFileRepository>(WORKFLOW_TOKENS.SpecFileRepository)
      .toConstantValue({ writeSpec });
    container
      .bind<IDecomposeService>(WORKFLOW_TOKENS.DecomposeService)
      .toConstantValue({ decompose });
    container
      .bind<ISpecSynthesisService>(WORKFLOW_TOKENS.SpecSynthesisService)
      .toConstantValue({ synthesize });
    container
      .bind<IWorkflowHandler>(WORKFLOW_TOKENS.WorkflowHandler)
      .to(WorkflowHandler);
    handler = container.get<IWorkflowHandler>(WORKFLOW_TOKENS.WorkflowHandler);

    logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => logSpy.mockRestore());

  it('writes the Draft spec to the target repo and prints gate instructions', async () => {
    const specPath = await handler.runDecompose(INPUT);

    expect(getPrd).toHaveBeenCalledWith('PRD-0099', '/tmp/docs');
    expect(decompose).toHaveBeenCalledTimes(1);
    expect(synthesize).toHaveBeenCalledWith([makeStory()], {
      prdId: 'PRD-0099',
      repoPath: '/tmp/target-repo',
      phase: 1,
      phaseTitle: 'Walk',
      owner: 'Russ Watson',
      budgetK: 200,
      date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/)
    });
    expect(writeSpec).toHaveBeenCalledWith(
      '/tmp/target-repo',
      'PRD-0099',
      1,
      '---\nstatus: Draft\n---\n# spec'
    );
    expect(specPath).toBe('/tmp/target-repo/specs/PRD-0099/phase-1-spec.md');

    const output = logSpy.mock.calls.map(c => String(c[0])).join('\n');
    expect(output).toContain('[HUMAN GATE]');
    expect(output).toContain('Draft → Approved');
    expect(output).toContain('docs: approve SPEC-PRD-0099-P1');
  });

  it('falls back to a generic phase title when the PRD has no matching rollout phase', async () => {
    await handler.runDecompose({ ...INPUT, phase: 3 });
    expect(synthesize).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ phaseTitle: 'Phase 3' })
    );
  });

  it('surfaces synthesis diff-forecast warnings in the CLI output', async () => {
    synthesize.mockResolvedValueOnce({
      specId: 'SPEC-PRD-0099-P1',
      prdId: 'PRD-0099',
      phase: 1,
      summary: 's',
      context: 'c',
      tasks: [makeTask()],
      envelope: makeEnvelope(),
      markdown: '---\nstatus: Draft\n---\n# spec',
      warnings: [
        'Task T-01: engineering notes reference "docs/out.md" outside the ' +
          "envelope's allowedPaths — likely mid-run breach"
      ]
    });

    await handler.runDecompose(INPUT);

    const output = logSpy.mock.calls.map(c => String(c[0])).join('\n');
    expect(output).toContain('docs/out.md');
    expect(output).toContain('outside the envelope');
  });

  it('propagates synthesis validation failure and writes nothing', async () => {
    synthesize.mockRejectedValueOnce(
      new WorkflowError('bad spec', 'SPEC_INVALID', ['Task T-01: untagged'])
    );

    await expect(handler.runDecompose(INPUT)).rejects.toMatchObject({
      code: 'SPEC_INVALID'
    });
    expect(writeSpec).not.toHaveBeenCalled();
  });
});
