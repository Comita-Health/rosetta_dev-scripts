import 'reflect-metadata';
import { Container } from 'inversify';
import { IGitRepository } from '../repositories/git.repository';
import { IInferenceRepository } from '../repositories/inference.repository';
import { ISurfaceMapRepository } from '../repositories/surface-map.repository';
import {
  ISpecSynthesisService,
  SpecSynthesisOptions,
  SpecSynthesisService,
  SPEC_SCHEMA
} from '../services/spec-synthesis.service';
import { WORKFLOW_TOKENS } from '../tokens';
import { SpecTask, WorkflowError } from '../types';
import { parseSpec } from '../utils/spec-parser';
import { renderSpec } from '../utils/spec-render';
import { makeStory } from './fixtures';

const OPTIONS: SpecSynthesisOptions = {
  prdId: 'PRD-0099',
  repoPath: '/tmp/target-repo',
  phase: 1,
  phaseTitle: 'Walk',
  owner: 'Russ Watson',
  budgetK: 300,
  date: '2026-07-31'
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
  let loadSurfaceMap: jest.Mock;
  let listFiles: jest.Mock;

  beforeEach(() => {
    generateJson = jest.fn();
    loadSurfaceMap = jest
      .fn()
      .mockReturnValue({ 'ci-config': ['.github/workflows/**'] });
    listFiles = jest.fn().mockReturnValue(REPO_FILES);
    container = new Container();
    container
      .bind<IInferenceRepository>(WORKFLOW_TOKENS.InferenceRepository)
      .toConstantValue({ generateJson });
    container
      .bind<ISurfaceMapRepository>(WORKFLOW_TOKENS.SurfaceMapRepository)
      .toConstantValue({ load: loadSurfaceMap });
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

  // #36 / SPEC-BUG-envelope-spec-integrity-P1 T-02: surface labels fail
  // closed at synthesis — never silently dropped.
  describe('forbiddenSurfaces fail closed (#36)', () => {
    it('aborts synthesis naming every unresolvable label and the known labels', async () => {
      loadSurfaceMap.mockReturnValue({
        'ci-config': ['.github/workflows/**'],
        migrations: ['**/migrations/**']
      });
      const payload = validPayload();
      payload.envelope.forbiddenSurfaces = [
        'ci-config',
        'payments-phi-boundary',
        'made-up-surface'
      ];
      generateJson.mockResolvedValueOnce(payload);

      const error = await service
        .synthesize([makeStory()], OPTIONS)
        .catch((e: WorkflowError) => e);

      expect(error).toBeInstanceOf(WorkflowError);
      expect((error as WorkflowError).code).toBe('SURFACE_UNRESOLVABLE');
      expect(loadSurfaceMap).toHaveBeenCalledWith('/tmp/target-repo');
      const details = (error as WorkflowError).details;
      expect(details).toContain(
        'unresolvable surface label: "payments-phi-boundary"'
      );
      expect(details).toContain(
        'unresolvable surface label: "made-up-surface"'
      );
      expect(details).toContain('known labels: ci-config, migrations');
      // Nothing dropped: the resolvable label is not reported, and no spec
      // with a thinned label list is ever produced (synthesis threw).
      expect(details).not.toContain('unresolvable surface label: "ci-config"');
    });

    it('fails closed when the repo has no surfaces.json at all', async () => {
      loadSurfaceMap.mockReturnValue({});
      generateJson.mockResolvedValueOnce(validPayload());

      await expect(
        service.synthesize([makeStory()], OPTIONS)
      ).rejects.toMatchObject({
        code: 'SURFACE_UNRESOLVABLE',
        details: expect.arrayContaining([
          'unresolvable surface label: "ci-config"',
          'known labels: (none — .sdlc/surfaces.json is missing or empty)'
        ])
      });
    });

    it('synthesizes byte-identically to current behavior when all labels resolve', async () => {
      generateJson.mockResolvedValueOnce(validPayload());

      const spec = await service.synthesize([makeStory()], OPTIONS);

      const payload = validPayload();
      expect(spec.markdown).toBe(
        renderSpec({
          specId: 'SPEC-PRD-0099-P1',
          prdId: OPTIONS.prdId,
          phase: OPTIONS.phase,
          owner: OPTIONS.owner,
          date: OPTIONS.date,
          summary: payload.summary,
          context: payload.context,
          tasks: payload.tasks.map(task => ({
            ...task,
            phase: OPTIONS.phase
          })) as SpecTask[],
          envelope: { ...payload.envelope, budgetK: OPTIONS.budgetK }
        })
      );
      expect(spec.envelope.forbiddenSurfaces).toEqual(['ci-config']);
    });

    it('round-trips an arbitrary consumer label PRD → spec → intake without loss', async () => {
      // A healthcare-shaped label the engine has never heard of — known only
      // to the consumer repo's surfaces.json.
      loadSurfaceMap.mockReturnValue({
        'payments-phi-boundary': ['src/payments/**', 'src/phi/**'],
        'ci-config': ['.github/workflows/**']
      });
      const payload = validPayload();
      payload.envelope.forbiddenSurfaces = [
        'payments-phi-boundary',
        'ci-config'
      ];
      generateJson.mockResolvedValueOnce(payload);

      const spec = await service.synthesize([makeStory()], OPTIONS);
      const intake = parseSpec(spec.markdown);

      expect(intake.envelope.forbiddenSurfaces).toEqual([
        'payments-phi-boundary',
        'ci-config'
      ]);
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
