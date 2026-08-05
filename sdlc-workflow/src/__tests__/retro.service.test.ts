import 'reflect-metadata';
import { Container } from 'inversify';
import type { IChronicleArtifactRepository } from '../repositories/chronicle-artifact.repository';
import type { IInferenceRepository } from '../repositories/inference.repository';
import type { IQueueRepository } from '../repositories/queue.repository';
import {
  IRetroService,
  isBugSpec,
  RetroService
} from '../services/retro.service';
import { WORKFLOW_TOKENS } from '../tokens';
import { GateVerdict } from '../types';

const verdict = (
  gate: string,
  outcome: GateVerdict['outcome'],
  reasons: string[] = []
): GateVerdict => ({
  gate,
  taskId: 'T-01',
  outcome,
  wouldEscalate: outcome !== 'pass',
  reasons,
  recordedAt: 'x'
});

const INPUT = {
  chronicleRepo: '/chronicle',
  runId: 'run-1',
  specId: 'SPEC-BUG-redirect-uri-P1',
  context: 'Symptom: the redirect_uri class bit three times.',
  verdicts: [verdict('envelope', 'breach', ['outside allowedPaths'])],
  exceptions: [
    {
      trigger: 'envelope-breach' as const,
      taskId: 'T-01',
      context: ['outside allowedPaths'],
      recordedAt: 'x'
    }
  ]
};

const ASSESSMENT = {
  recommendations: [
    {
      stage: 'envelope',
      check: 'lint redirect_uri allow-lists at decompose time',
      rationale: 'the breach was a static envelope gap, not a runtime one'
    }
  ]
};

describe('RetroService (SPEC-BUG-retro-and-queued-plans-P1 T-01)', () => {
  let service: IRetroService;
  let generateJson: jest.Mock;
  let appendItem: jest.Mock;
  let writeArtifact: jest.Mock;
  let commit: jest.Mock;

  beforeEach(() => {
    generateJson = jest.fn().mockResolvedValue(ASSESSMENT);
    appendItem = jest.fn().mockReturnValue(true);
    writeArtifact = jest.fn().mockReturnValue('chronicles/sdlc/run-1/retro.json');
    commit = jest.fn();

    const container = new Container();
    container.bind<IInferenceRepository>(WORKFLOW_TOKENS.InferenceRepository).toConstantValue({ generateJson });
    container
      .bind<IQueueRepository>(WORKFLOW_TOKENS.QueueRepository)
      .toConstantValue({ appendItem, itemTags: jest.fn() });
    container
      .bind<IChronicleArtifactRepository>(WORKFLOW_TOKENS.ChronicleArtifactRepository)
      .toConstantValue({ writeArtifact, readArtifacts: jest.fn().mockReturnValue([]), commit });
    container.bind<IRetroService>(WORKFLOW_TOKENS.RetroService).to(RetroService);
    service = container.get<IRetroService>(WORKFLOW_TOKENS.RetroService);
  });

  it('dispatches one inference call over the Context + verdict/exception history, writes one sdlc.retro.v1 artifact with stage-attributed recommendations, and links exactly one queue item', async () => {
    const outcome = await service.post(INPUT);

    expect(generateJson).toHaveBeenCalledTimes(1);
    const [prompt, schema] = generateJson.mock.calls[0];
    expect(prompt).toContain(INPUT.context);
    expect(prompt).toContain('envelope: breach');
    expect(prompt).toContain('envelope-breach');
    expect(schema.required).toEqual(['recommendations']);

    expect(writeArtifact).toHaveBeenCalledTimes(1);
    expect(writeArtifact).toHaveBeenCalledWith(
      '/chronicle',
      'run-1',
      'retro',
      expect.objectContaining({ schema: 'sdlc.retro.v1' })
    );
    expect(outcome.retro.recommendations).toEqual(ASSESSMENT.recommendations);
    expect(outcome.artifactPath).toBe('chronicles/sdlc/run-1/retro.json');

    expect(appendItem).toHaveBeenCalledTimes(1);
    const [repoArg, title, tags] = appendItem.mock.calls[0];
    expect(repoArg).toBe('/chronicle');
    expect(title).toContain('run-1');
    expect(title).toContain(INPUT.specId);
    expect(title).toContain('chronicles/sdlc/run-1/retro.json');
    expect(tags).toEqual(['retro']);
    expect(commit).toHaveBeenCalledWith(
      '/chronicle',
      'retro',
      expect.stringContaining('run-1')
    );
  });

  it('propagates an inference failure rather than swallowing it — the caller owns the loud-but-nonblocking contract', async () => {
    generateJson.mockRejectedValue(new Error('model backend unavailable'));

    await expect(service.post(INPUT)).rejects.toThrow(
      'model backend unavailable'
    );
    expect(writeArtifact).not.toHaveBeenCalled();
    expect(appendItem).not.toHaveBeenCalled();
  });

  it('isBugSpec matches SPEC-BUG-* and rejects PRD-run specs', () => {
    expect(isBugSpec('SPEC-BUG-retro-and-queued-plans-P1')).toBe(true);
    expect(isBugSpec('SPEC-PRD-0011-P2')).toBe(false);
  });
});
