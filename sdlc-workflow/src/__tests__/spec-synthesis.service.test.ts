import 'reflect-metadata';
import { Container } from 'inversify';
import { IGitRepository } from '../repositories/git.repository';
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
  date: '2026-07-31',
  repoPath: '/tmp/target-repo'
};

/** The target repo tree envelope grounding runs against (#35). */
const REPO_FILES = ['src/index.ts', 'src/services/api.service.ts', 'README.md'];

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
  let listFiles: jest.Mock;

  beforeEach(() => {
    generateJson = jest.fn();
    listFiles = jest.fn().mockReturnValue(REPO_FILES);
    container = new Container();
    container
      .bind<IInferenceRepository>(WORKFLOW_TOKENS.InferenceRepository)
      .toConstantValue({ generateJson });
    container
      .bind<IGitRepository>(WORKFLOW_TOKENS.GitRepository)
      .toConstantValue({ listFiles } as unknown as IGitRepository);
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

  // --- #35: envelope grounding in the target repo tree ---

  it('fails synthesis naming a glob that matches nothing and has no new-path justification', async () => {
    const payload = validPayload();
    payload.envelope.allowedPaths = ['src/**', 'imaginary/**'];
    generateJson.mockResolvedValueOnce(payload);

    const error = await service
      .synthesize([makeStory()], OPTIONS)
      .catch((e: WorkflowError) => e);

    expect(error).toBeInstanceOf(WorkflowError);
    expect((error as WorkflowError).code).toBe('ENVELOPE_UNGROUNDED');
    expect((error as WorkflowError).details.join('\n')).toContain(
      '"imaginary/**"'
    );
    expect(listFiles).toHaveBeenCalledWith('/tmp/target-repo');
  });

  it('passes grounding for justified new-file intents and unchanged existing-path globs', async () => {
    const payload = validPayload();
    // `lib/**` matches nothing in the tree, but T-01 explicitly names the
    // new file it creates under it — a justified new-path intent.
    payload.envelope.allowedPaths = ['src/**', 'lib/**'];
    payload.tasks[0].engineeringNotes =
      'Creates `lib/foo.service.ts` mirroring the sibling package.';
    generateJson.mockResolvedValueOnce(payload);

    const spec = await service.synthesize([makeStory()], OPTIONS);

    expect(spec.envelope.allowedPaths).toEqual(['src/**', 'lib/**']);
    expect(spec.warnings).toEqual([]);
  });

  it('warns when a task note references a path outside the envelope', async () => {
    const payload = validPayload();
    payload.tasks[1].engineeringNotes =
      'Also updates `README.md` and touches docs/setup.md for the new flag.';
    generateJson.mockResolvedValueOnce(payload);

    const spec = await service.synthesize([makeStory()], OPTIONS);

    expect(spec.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Task T-02'),
        expect.stringContaining('"docs/setup.md"')
      ])
    );
    expect(spec.warnings.every(w => w.includes('outside the envelope'))).toBe(
      true
    );
  });
});
