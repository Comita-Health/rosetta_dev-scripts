import { inject, injectable } from 'inversify';
import type { IInferenceRepository } from '../repositories/inference.repository';
import { WORKFLOW_TOKENS } from '../tokens';
import {
  Envelope,
  ProductStory,
  SpecTask,
  SynthesizedSpec,
  WorkflowError
} from '../types';
import { JsonSchema } from '../utils/json-schema';
import { renderSpec } from '../utils/spec-render';
import { validateSpec } from '../utils/spec-validate';

export interface SpecSynthesisOptions {
  prdId: string;
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
  options: SpecSynthesisOptions
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
    '  "migrations", "auth", "ci-config"), maxDiffLines a hard size cap.',
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
    private readonly _inference: IInferenceRepository
  ) {}

  async synthesize(
    stories: ProductStory[],
    options: SpecSynthesisOptions
  ): Promise<SynthesizedSpec> {
    const payload = await this._inference.generateJson<SpecPayload>(
      buildPrompt(stories, options),
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

    const violations = validateSpec(tasks, envelope);
    if (violations.length > 0) {
      throw new WorkflowError(
        'Synthesized spec violates the ADR-0008 format',
        'SPEC_INVALID',
        violations
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
      markdown
    };
  }
}
