import 'reflect-metadata';
import { Container } from 'inversify';
import { IInferenceRepository } from '../repositories/inference.repository';
import {
  DecomposeService,
  IDecomposeService,
  STORIES_SCHEMA
} from '../services/decompose.service';
import { WORKFLOW_TOKENS } from '../tokens';
import { ParsedPrd } from '../types';

const PRD: ParsedPrd = {
  id: 'PRD-0099',
  title: 'Test Capability',
  status: 'Proposed',
  owner: 'Russ Watson',
  goals: ['Goal one', 'Goal two'],
  nonGoals: ['Not this'],
  acceptanceCriteria: ['It works'],
  rolloutPhases: [{ number: 1, title: 'Walk', description: 'Minimal loop' }]
};

describe('DecomposeService', () => {
  let container: Container;
  let service: IDecomposeService;
  let generateJson: jest.Mock;

  beforeEach(() => {
    generateJson = jest.fn();
    container = new Container();
    container
      .bind<IInferenceRepository>(WORKFLOW_TOKENS.InferenceRepository)
      .toConstantValue({ generateJson });
    container
      .bind<IDecomposeService>(WORKFLOW_TOKENS.DecomposeService)
      .to(DecomposeService);
    service = container.get<IDecomposeService>(
      WORKFLOW_TOKENS.DecomposeService
    );
  });

  it('returns stories conforming to the ProductStory contract with sequential IDs', async () => {
    generateJson.mockResolvedValueOnce({
      stories: [
        {
          title: 'First',
          asA: 'user',
          iWant: 'x',
          soThat: 'y',
          acceptanceCriteria: ['a']
        },
        {
          title: 'Second',
          asA: 'user',
          iWant: 'x2',
          soThat: 'y2',
          acceptanceCriteria: ['b']
        }
      ]
    });

    const stories = await service.decompose(PRD);

    expect(stories.map(s => s.id)).toEqual(['S-01', 'S-02']);
    expect(stories[0]).toMatchObject({
      title: 'First',
      asA: 'user',
      iWant: 'x',
      soThat: 'y',
      acceptanceCriteria: ['a']
    });
    expect(generateJson).toHaveBeenCalledWith(
      expect.stringContaining('Goal one'),
      STORIES_SCHEMA
    );
    expect(generateJson.mock.calls[0][0]).toContain('Right-sizing');
    expect(generateJson.mock.calls[0][0]).toContain('Not this');
  });

  it('yields a typed error for a goal-less PRD instead of an empty story list', async () => {
    await expect(
      service.decompose({ ...PRD, goals: [] })
    ).rejects.toMatchObject({ name: 'WorkflowError', code: 'DECOMPOSE_EMPTY' });
    expect(generateJson).not.toHaveBeenCalled();
  });
});
