import { inject, injectable } from 'inversify';
import type { IGitRepository } from '../repositories/git.repository';
import type { IInferenceRepository } from '../repositories/inference.repository';
import type { ISurfaceMapRepository } from '../repositories/surface-map.repository';
import { WORKFLOW_TOKENS } from '../tokens';
import {
  Envelope,
  ProductStory,
  SpecTask,
  SynthesizedSpec,
  WorkflowError
} from '../types';
import { groundAllowedPaths } from '../utils/envelope-grounding';
import { JsonSchema } from '../utils/json-schema';
import { renderSpec } from '../utils/spec-render';
import { validateSpec } from '../utils/spec-validate';

export interface SpecSynthesisOptions {
  prdId: string;
  /**
   * Target repo checkout: its `.sdlc/surfaces.json` grounds forbiddenSurfaces
   * (#36) and its tree grounds allowedPaths (#35).
   */
  repoPath: string;
  phase: number;
  phaseTitle: string;
  owner: string;
  budgetK: number;
  date: string; // YYYY-MM-DD
}

export interface ISpecSynthesisService {
  /**
   * Turn product stories into an ADR-0008 implementation spec: tasks with
   * tier-tagged acceptance criteria, a blast-radius envelope, and rendered
   * Markdown. Fails with SPEC_INVALID when the result violates the format.
   *
   * Surface labels fail closed (#36): every `forbiddenSurfaces` label must
   * resolve against the target repo's `.sdlc/surfaces.json`. An unresolvable
   * label aborts synthesis with SURFACE_UNRESOLVABLE — naming the label and
   * listing the repo's known labels — rather than shipping (or dropping) a
   * label no gate can enforce.
   */
  synthesize(
    stories: ProductStory[],
    options: SpecSynthesisOptions
  ): Promise<SynthesizedSpec>;
}

const TASK_SCHEMA: JsonSchema = {
  type: 'object',
  required: [
    'id',
    'storyId',
    'title',
    'engineeringNotes',
    'complexity',
    'dependsOn',
    'acceptanceCriteria'
  ],
  properties: {
    id: { type: 'string' },
    storyId: { type: 'string' },
    title: { type: 'string' },
    engineeringNotes: { type: 'string' },
    complexity: { type: 'string', enum: ['S', 'M', 'L'] },
    dependsOn: { type: 'array', items: { type: 'string' } },
    acceptanceCriteria: {
      type: 'array',
      minItems: 1,
      items: { type: 'string' }
    }
  }
};

export const SPEC_SCHEMA: JsonSchema = {
  type: 'object',
  required: ['summary', 'context', 'envelope', 'tasks'],
  properties: {
    summary: { type: 'string' },
    context: { type: 'string' },
    envelope: {
      type: 'object',
      required: ['allowedPaths', 'forbiddenSurfaces', 'maxDiffLines'],
      properties: {
        allowedPaths: {
          type: 'array',
          minItems: 1,
          items: { type: 'string' }
        },
        forbiddenSurfaces: { type: 'array', items: { type: 'string' } },
        maxDiffLines: { type: 'number' }
      }
    },
    tasks: { type: 'array', minItems: 1, items: TASK_SCHEMA }
  }
};

const buildPrompt = (
  stories: ProductStory[],
  options: SpecSynthesisOptions,
  knownSurfaceLabels: string[]
): string =>
  [
    `Synthesize an implementation spec for phase ${options.phase}`,
    `("${options.phaseTitle}") of ${options.prdId} from these product stories:`,
    '',
    JSON.stringify(stories, null, 2),
    '',
    'Rules:',
    '- Task IDs are sequential: T-01, T-02, ... dependsOn references task IDs.',
    '- Every acceptance criterion MUST start with a verification-tier tag:',
    '  "test: " (asserted by a scripted test in CI), "agent: " (verified by an',
    '  agent using the running interface), or "manual: " (human-only — avoid;',
    '  it disables auto-advance for the phase).',
    '- Prefer test: criteria; use agent: for end-to-end interface behavior.',
    '- The envelope is the blast radius: allowedPaths globs the implementation',
    '  may modify, forbiddenSurfaces labels it must not touch (e.g.',
    '  "migrations", "auth", "ci-config"), maxDiffLines an advisory size note.',
    "- forbiddenSurfaces entries MUST come from the target repo's known",
    `  surface labels: ${
      knownSurfaceLabels.length > 0
        ? knownSurfaceLabels.join(', ')
        : '(none defined — leave forbiddenSurfaces empty)'
    }.`,
    '- Every allowedPaths glob must be grounded in the target repo tree:',
    '  match paths that exist today, or cover a new file a task explicitly',
    '  creates — name that new path in the task engineeringNotes.',
    '- engineeringNotes carry intent and constraints, not restated criteria.'
  ].join('\n');

interface SpecPayload {
  summary: string;
  context: string;
  envelope: Omit<Envelope, 'budgetK'> & { budgetK?: number };
  tasks: Array<Omit<SpecTask, 'phase'>>;
}

@injectable()
export class SpecSynthesisService implements ISpecSynthesisService {
  constructor(
    @inject(WORKFLOW_TOKENS.InferenceRepository)
    private readonly _inference: IInferenceRepository,
    @inject(WORKFLOW_TOKENS.SurfaceMapRepository)
    private readonly _surfaceMap: ISurfaceMapRepository,
    @inject(WORKFLOW_TOKENS.GitRepository)
    private readonly _gitRepo: IGitRepository
  ) {}

  async synthesize(
    stories: ProductStory[],
    options: SpecSynthesisOptions
  ): Promise<SynthesizedSpec> {
    const surfaceMap = this._surfaceMap.load(options.repoPath);
    const knownLabels = Object.keys(surfaceMap);

    const payload = await this._inference.generateJson<SpecPayload>(
      buildPrompt(stories, options, knownLabels),
      SPEC_SCHEMA
    );

    const envelope: Envelope = {
      allowedPaths: payload.envelope.allowedPaths,
      forbiddenSurfaces: payload.envelope.forbiddenSurfaces,
      maxDiffLines: payload.envelope.maxDiffLines,
      budgetK: options.budgetK
    };
    const tasks: SpecTask[] = payload.tasks.map(task => ({
      ...task,
      phase: options.phase
    }));

    // #36: fail closed. A label that does not resolve against the target
    // repo's surface map would render a gate that can never enforce it —
    // abort loudly rather than let the label ship (or vanish) unreviewed.
    const unresolvable = envelope.forbiddenSurfaces.filter(
      label => surfaceMap[label] === undefined
    );
    if (unresolvable.length > 0) {
      throw new WorkflowError(
        `forbiddenSurfaces labels do not resolve against ` +
          `${options.repoPath}/.sdlc/surfaces.json — failing closed instead ` +
          `of dropping them`,
        'SURFACE_UNRESOLVABLE',
        [
          ...unresolvable.map(
            label => `unresolvable surface label: "${label}"`
          ),
          knownLabels.length > 0
            ? `known labels: ${knownLabels.join(', ')}`
            : 'known labels: (none — .sdlc/surfaces.json is missing or empty)'
        ]
      );
    }

    const violations = validateSpec(tasks, envelope);
    if (violations.length > 0) {
      throw new WorkflowError(
        'Synthesized spec violates the ADR-0008 format',
        'SPEC_INVALID',
        violations
      );
    }

    // #35: the envelope must describe reality, not an LLM guess. Every glob
    // either matches the target tree or is justified by a task naming the
    // new path it creates; anything else fails synthesis loudly.
    const grounding = groundAllowedPaths(
      envelope.allowedPaths,
      tasks,
      this._gitRepo.listFiles(options.repoPath)
    );
    if (grounding.ungroundedGlobs.length > 0) {
      throw new WorkflowError(
        'Synthesized allowedPaths are not grounded in the target repo tree',
        'ENVELOPE_UNGROUNDED',
        grounding.ungroundedGlobs.map(
          glob =>
            `ungrounded glob "${glob}": matches nothing in the repo tree ` +
            `and no task names a new path under it`
        )
      );
    }

    const specId = `SPEC-${options.prdId}-P${options.phase}`;
    const markdown = renderSpec({
      specId,
      prdId: options.prdId,
      phase: options.phase,
      owner: options.owner,
      date: options.date,
      summary: payload.summary,
      context: payload.context,
      tasks,
      envelope
    });

    return {
      specId,
      prdId: options.prdId,
      phase: options.phase,
      summary: payload.summary,
      context: payload.context,
      tasks,
      envelope,
      markdown,
      warnings: grounding.warnings
    };
  }
}
