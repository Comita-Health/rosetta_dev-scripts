import 'reflect-metadata';
import { Container } from 'inversify';
import type { IChronicleArtifactRepository } from '../repositories/chronicle-artifact.repository';
import type { IQueueRepository } from '../repositories/queue.repository';
import {
  DigestService,
  evidenceLink,
  IDigestService
} from '../services/digest.service';
import { WORKFLOW_TOKENS } from '../tokens';
import { ExceptionEntry, GateVerdict } from '../types';

const verdict = (
  gate: string,
  outcome: GateVerdict['outcome'],
  evidenceIds?: string[]
): GateVerdict => ({
  gate,
  taskId: 'T-01',
  outcome,
  wouldEscalate: outcome !== 'pass',
  reasons: [`${gate} says ${outcome}`],
  evidenceIds,
  recordedAt: 'x'
});

const INPUT = {
  chronicleRepo: '/chronicle',
  runId: 'run-1',
  specId: 'SPEC-PRD-0099-P2',
  taskId: 'T-01',
  phaseVerdict: verdict('phase', 'breach'),
  verdicts: [
    verdict('envelope', 'pass'),
    verdict('verification', 'breach', ['T-01-test-output']),
    verdict('phase', 'breach')
  ],
  exceptions: [
    {
      trigger: 'envelope-breach',
      taskId: 'T-01',
      context: ['outside allowedPaths'],
      recordedAt: 'x'
    }
  ] as ExceptionEntry[]
};

describe('DigestService (T-07 phase-boundary digest)', () => {
  let service: IDigestService;
  let appendItem: jest.Mock;
  let writeArtifact: jest.Mock;
  let readArtifacts: jest.Mock;
  let commit: jest.Mock;

  beforeEach(() => {
    appendItem = jest.fn().mockReturnValue(true);
    writeArtifact = jest
      .fn()
      .mockReturnValue('chronicles/sdlc/run-1/digest-T-01.json');
    readArtifacts = jest.fn().mockReturnValue([]);
    commit = jest.fn();

    const container = new Container();
    container
      .bind<IQueueRepository>(WORKFLOW_TOKENS.QueueRepository)
      .toConstantValue({ appendItem, itemTags: jest.fn() });
    container
      .bind<IChronicleArtifactRepository>(
        WORKFLOW_TOKENS.ChronicleArtifactRepository
      )
      .toConstantValue({ writeArtifact, readArtifacts, commit });
    container
      .bind<IDigestService>(WORKFLOW_TOKENS.DigestService)
      .to(DigestService);
    service = container.get<IDigestService>(WORKFLOW_TOKENS.DigestService);
  });

  it('posts exactly one digest containing task id, aggregate verdict, evidence links, and exceptions', async () => {
    const outcome = await service.post(INPUT);

    expect(appendItem).toHaveBeenCalledTimes(1);
    const [repoArg, title, tags] = appendItem.mock.calls[0];
    expect(repoArg).toBe('/chronicle');
    expect(title).toContain('run-1');
    expect(title).toContain('T-01');
    expect(title).toContain('breach');
    expect(tags).toEqual(['follow-up']);

    expect(outcome.digest.taskId).toBe('T-01');
    expect(outcome.digest.phaseOutcome).toBe('breach');
    expect(outcome.digest.exceptions).toEqual(INPUT.exceptions);
    const verification = outcome.digest.gates.find(
      gate => gate.gate === 'verification'
    );
    expect(verification?.evidenceLinks).toEqual([
      evidenceLink('run-1', 'T-01-test-output')
    ]);
    expect(outcome.queueAppended).toBe(true);
  });

  it('commits the digest artifact with the chronicle(queue) scope', async () => {
    await service.post(INPUT);

    expect(writeArtifact).toHaveBeenCalledWith(
      '/chronicle',
      'run-1',
      'digest-T-01',
      expect.objectContaining({ schema: 'sdlc.digest.v1' })
    );
    expect(commit).toHaveBeenCalledWith(
      '/chronicle',
      'queue',
      expect.stringContaining('run-1 T-01')
    );
  });

  it('includes merged SHAs on the phase-boundary digest (P3 T-05)', async () => {
    const outcome = await service.post({
      ...INPUT,
      taskId: 'phase',
      merges: [
        { taskId: 'T-01', mergedSha: 'aaa' },
        { taskId: 'T-02', mergedSha: 'bbb' }
      ]
    });

    expect(outcome.digest.merges).toEqual([
      { taskId: 'T-01', mergedSha: 'aaa' },
      { taskId: 'T-02', mergedSha: 'bbb' }
    ]);
    expect(appendItem.mock.calls[0][1]).toContain('phase');
  });

  // SPEC-PRD-0023-P1 T-05: the closeout PR is reachable from the run's own
  // Chronicle record, so "was this phase documented" is answerable from the
  // ledger rather than from someone's memory of a PR number.
  it('links the closeout PR into the phase artifact once one exists', async () => {
    const outcome = await service.post({
      ...INPUT,
      taskId: 'phase',
      merges: [{ taskId: 'T-01', mergedSha: 'aaa' }],
      closeoutPrUrl: 'https://github.com/o/r/pull/12'
    });

    expect(outcome.digest.closeoutPr).toBe('https://github.com/o/r/pull/12');
    expect(writeArtifact).toHaveBeenCalledWith(
      '/chronicle',
      'run-1',
      'digest-phase',
      expect.objectContaining({
        payload: expect.objectContaining({
          closeoutPr: 'https://github.com/o/r/pull/12'
        })
      })
    );
  });

  it('populates no closeout link for a phase that has none yet', async () => {
    const outcome = await service.post({ ...INPUT, taskId: 'phase' });

    expect(outcome.digest.closeoutPr).toBeUndefined();
    expect(Object.keys(outcome.digest)).not.toContain('closeoutPr');
  });

  it('re-posting is a no-op append (resume never duplicates the digest)', async () => {
    await service.post(INPUT);
    appendItem.mockReturnValue(false); // title already present in queue.md

    const second = await service.post(INPUT);

    expect(second.queueAppended).toBe(false);
    expect(appendItem).toHaveBeenCalledTimes(2); // idempotent at the file
  });

  it('has no veto or revert path: a simulated veto changes nothing', async () => {
    await service.post(INPUT);

    // Simulated veto: the human checks the item off / rejects it, and the
    // queue reports no append on the next post. Informational-only
    // semantics: the service exposes no revert surface and performs only
    // append/write/commit calls — never a rollback.
    appendItem.mockReturnValue(false);
    const afterVeto = await service.post(INPUT);

    expect(afterVeto.queueAppended).toBe(false);
    const serviceKeys = Object.getOwnPropertyNames(
      Object.getPrototypeOf(service)
    );
    expect(serviceKeys).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/veto|revert|rollback/i)])
    );
    // Only additive operations were ever invoked.
    expect(appendItem).toHaveBeenCalled();
    expect(writeArtifact).toHaveBeenCalled();
    expect(commit).toHaveBeenCalled();
  });
});
