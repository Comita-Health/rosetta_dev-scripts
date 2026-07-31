import { inject, injectable } from 'inversify';
import type { IInferenceRepository } from '../repositories/inference.repository';
import { WORKFLOW_TOKENS } from '../tokens';
import { ParsedPrd, ProductStory, WorkflowError } from '../types';
import { JsonSchema } from '../utils/json-schema';

export interface IDecomposeService {
  /** Decompose a parsed PRD into right-sized product stories (PRD-0011 §4). */
  decompose(prd: ParsedPrd): Promise<ProductStory[]>;
}

const STORY_SCHEMA: JsonSchema = {
  type: 'object',
  required: ['title', 'asA', 'iWant', 'soThat', 'acceptanceCriteria'],
  properties: {
    title: { type: 'string' },
    asA: { type: 'string' },
    iWant: { type: 'string' },
    soThat: { type: 'string' },
    acceptanceCriteria: {
      type: 'array',
      minItems: 1,
      items: { type: 'string' }
    }
  }
};

export const STORIES_SCHEMA: JsonSchema = {
  type: 'object',
  required: ['stories'],
  properties: {
    stories: { type: 'array', minItems: 1, items: STORY_SCHEMA }
  }
};

const buildPrompt = (prd: ParsedPrd): string =>
  [
    `Decompose this PRD into product stories (user-story format).`,
    '',
    `PRD ${prd.id}: ${prd.title}`,
    '',
    'Goals:',
    ...prd.goals.map(g => `- ${g}`),
    '',
    'Non-goals (out of scope — do not create stories for these):',
    ...prd.nonGoals.map(g => `- ${g}`),
    '',
    'PRD acceptance criteria:',
    ...prd.acceptanceCriteria.map(c => `- ${c}`),
    '',
    'Right-sizing guidance: prefer few, cohesive stories over many fragments.',
    'Each story must be independently valuable and traceable to a goal. Do not',
    'invent scope beyond the goals; a small PRD may yield only 2-3 stories.'
  ].join('\n');

@injectable()
export class DecomposeService implements IDecomposeService {
  constructor(
    @inject(WORKFLOW_TOKENS.InferenceRepository)
    private readonly _inference: IInferenceRepository
  ) {}

  async decompose(prd: ParsedPrd): Promise<ProductStory[]> {
    if (prd.goals.length === 0) {
      throw new WorkflowError(
        `${prd.id} has no goals to decompose — a PRD without goals cannot yield stories`,
        'DECOMPOSE_EMPTY'
      );
    }

    const result = await this._inference.generateJson<{
      stories: Array<Omit<ProductStory, 'id'>>;
    }>(buildPrompt(prd), STORIES_SCHEMA);

    return result.stories.map((story, i) => ({
      ...story,
      id: `S-${String(i + 1).padStart(2, '0')}`
    }));
  }
}
