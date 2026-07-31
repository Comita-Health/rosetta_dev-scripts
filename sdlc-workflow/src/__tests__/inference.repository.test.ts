import 'reflect-metadata';
import { Container } from 'inversify';
import { IAnthropicRepository } from '../repositories/anthropic.repository';
import {
  InferenceRepository,
  IInferenceRepository
} from '../repositories/inference.repository';
import { WORKFLOW_TOKENS } from '../tokens';
import { JsonSchema } from '../utils/json-schema';

const SCHEMA: JsonSchema = {
  type: 'object',
  required: ['name'],
  properties: { name: { type: 'string' } }
};

describe('InferenceRepository', () => {
  let container: Container;
  let repo: IInferenceRepository;
  let complete: jest.Mock;

  beforeEach(() => {
    complete = jest.fn();
    container = new Container();
    container
      .bind<IAnthropicRepository>(WORKFLOW_TOKENS.AnthropicRepository)
      .toConstantValue({ complete });
    container
      .bind<IInferenceRepository>(WORKFLOW_TOKENS.InferenceRepository)
      .to(InferenceRepository);
    repo = container.get<IInferenceRepository>(
      WORKFLOW_TOKENS.InferenceRepository
    );
  });

  it('returns schema-valid output parsed', async () => {
    complete.mockResolvedValueOnce('{"name": "ok"}');
    await expect(repo.generateJson('prompt', SCHEMA)).resolves.toEqual({
      name: 'ok'
    });
    expect(complete).toHaveBeenCalledTimes(1);
    expect(complete.mock.calls[0][0]).toContain('prompt');
    expect(complete.mock.calls[0][0]).toContain('JSON schema');
  });

  it('unwraps fenced JSON', async () => {
    complete.mockResolvedValueOnce('Sure!\n```json\n{"name": "ok"}\n```');
    await expect(repo.generateJson('p', SCHEMA)).resolves.toEqual({
      name: 'ok'
    });
  });

  it('retries exactly once on schema-invalid output, quoting violations', async () => {
    complete
      .mockResolvedValueOnce('{"name": 42}')
      .mockResolvedValueOnce('{"name": "fixed"}');

    await expect(repo.generateJson('p', SCHEMA)).resolves.toEqual({
      name: 'fixed'
    });
    expect(complete).toHaveBeenCalledTimes(2);
    expect(complete.mock.calls[1][0]).toContain('violated the schema');
    expect(complete.mock.calls[1][0]).toContain('$.name');
  });

  it('retries once on unparseable output', async () => {
    complete
      .mockResolvedValueOnce('not json at all')
      .mockResolvedValueOnce('{"name": "fixed"}');

    await expect(repo.generateJson('p', SCHEMA)).resolves.toEqual({
      name: 'fixed'
    });
    expect(complete.mock.calls[1][0]).toContain('not parseable JSON');
  });

  it('surfaces a typed error carrying the validation failure after the retry', async () => {
    complete
      .mockResolvedValueOnce('{"name": 1}')
      .mockResolvedValueOnce('{"name": 2}');

    await expect(repo.generateJson('p', SCHEMA)).rejects.toMatchObject({
      name: 'WorkflowError',
      code: 'INFERENCE_INVALID',
      details: ['$.name: expected string, got number']
    });
    expect(complete).toHaveBeenCalledTimes(2);
  });
});
