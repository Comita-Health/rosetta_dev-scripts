import 'reflect-metadata';
import { Container } from 'inversify';
import { IInferenceRepository } from '../repositories/inference.repository';
import {
  ISpecSynthesisService,
  SpecSynthesisOptions,
  SpecSynthesisService,
  SPEC_SCHEMA
} from '../services/spec-synthesis.service';
import { WORKFLOW_TOKENS } from '../tokens';
import { WorkflowError } from '../types';
import { makeStory } from './fixtures';

const OPTIONS: SpecSynthesisOptions = {
  prdId: 'PRD-0099',
  phase: 1,
  phaseTitle: 'Walk',
  owner: 'Russ Watson',
  budgetK: 300,
  date: '2026-07-31'
};

const validPayload = () => ({
  summary: 'Walk phase',
  context: 'Builds the minimal loop.',
  envelope: {
    allowedPaths: ['src/**'],
    forbiddenSurfaces: ['ci-config'],
    maxDiffLines: 800
  },
  tasks: [
    {
      id: 'T-01',
      storyId: 'S-01',
      title: 'Scaffold',
      engineeringNotes: 'Mirror the sibling package.',
      complexity: 'S',
      dependsOn: [],
      acceptanceCriteria: ['test: it builds']
    },
    {
      id: 'T-02',
      storyId: 'S-01',
      title: 'Wire it',
      engineeringNotes: 'Compose at the handler.',
      complexity: 'M',
      dependsOn: ['T-01'],
      acceptanceCriteria: ['test: it wires', 'agent: it works end to end']
    }
  ]
});

describe('SpecSynthesisService', () => {
  let container: Container;
  let service: ISpecSynthesisService;
  let generateJson: jest.Mock;

  beforeEach(() => {
    generateJson = jest.fn();
    container = new Container();
    container
      .bind<IInferenceRepository>(WORKFLOW_TOKENS.InferenceRepository)
      .toConstantValue({ generateJson });
    container
      .bind<ISpecSynthesisService>(WORKFLOW_TOKENS.SpecSynthesisService)
      .to(SpecSynthesisService);
    service = container.get<ISpecSynthesisService>(
      WORKFLOW_TOKENS.SpecSynthesisService
    );
  });

  it('renders a spec that parses back: frontmatter, tasks, tagged criteria', async () => {
    generateJson.mockResolvedValueOnce(validPayload());

    const spec = await service.synthesize([makeStory()], OPTIONS);

    expect(spec.specId).toBe('SPEC-PRD-0099-P1');
    expect(spec.tasks.every(t => t.phase === 1)).toBe(true);
    expect(spec.envelope.budgetK).toBe(300);
    expect(generateJson).toHaveBeenCalledWith(expect.any(String), SPEC_SCHEMA);

    const md = spec.markdown;
    const frontmatter = md.match(/^---\n([\s\S]*?)\n---/);
    expect(frontmatter).not.toBeNull();
    const fm = (frontmatter as RegExpMatchArray)[1];
    expect(fm).toContain('id: SPEC-PRD-0099-P1');
    expect(fm).toContain('prd: PRD-0099');
    expect(fm).toContain('phase: 1');
    expect(fm).toContain('status: Draft');
    expect(fm).toContain('allowedPaths: ["src/**"]');
    expect(fm).toContain('forbiddenSurfaces: ["ci-config"]');
    expect(fm).toContain('maxDiffLines: 800');
    expect(fm).toContain('budgetK: 300');

    expect(md).toContain('## Task T-01: Scaffold');
    expect(md).toContain('## Task T-02: Wire it');
    expect(md).toContain('- **Depends on:** [T-01]');
    const criteria = md.match(/^- \[ \] (.+)$/gm) ?? [];
    expect(criteria.length).toBe(3);
    for (const line of criteria) {
      expect(line).toMatch(/- \[ \] (test|agent|manual): /);
    }
  });

  it('fails validation naming task and criterion for an untagged criterion', async () => {
    const payload = validPayload();
    payload.tasks[1].acceptanceCriteria = ['it just works'];
    generateJson.mockResolvedValueOnce(payload);

    const error = await service
      .synthesize([makeStory()], OPTIONS)
      .catch((e: WorkflowError) => e);

    expect(error).toBeInstanceOf(WorkflowError);
    expect((error as WorkflowError).code).toBe('SPEC_INVALID');
    expect((error as WorkflowError).details.join('\n')).toContain('Task T-02');
    expect((error as WorkflowError).details.join('\n')).toContain(
      '"it just works"'
    );
  });

  it('fails validation for a task depending on an unknown task ID', async () => {
    const payload = validPayload();
    payload.tasks[1].dependsOn = ['T-99'];
    generateJson.mockResolvedValueOnce(payload);

    await expect(
      service.synthesize([makeStory()], OPTIONS)
    ).rejects.toMatchObject({
      code: 'SPEC_INVALID',
      details: expect.arrayContaining([
        expect.stringContaining('unknown task "T-99"')
      ])
    });
  });
});
