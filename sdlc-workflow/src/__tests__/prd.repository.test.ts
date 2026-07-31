import 'reflect-metadata';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { Container } from 'inversify';
import { PrdRepository, IPrdRepository } from '../repositories/prd.repository';
import { WORKFLOW_TOKENS } from '../tokens';
import { WorkflowError } from '../types';
import { PRD_FIXTURE } from './fixtures';

describe('PrdRepository', () => {
  let container: Container;
  let repo: IPrdRepository;
  let docsDir: string;

  beforeEach(() => {
    container = new Container();
    container
      .bind<IPrdRepository>(WORKFLOW_TOKENS.PrdRepository)
      .to(PrdRepository);
    repo = container.get<IPrdRepository>(WORKFLOW_TOKENS.PrdRepository);
    docsDir = mkdtempSync(path.join(os.tmpdir(), 'prd-repo-'));
  });

  afterEach(() => rmSync(docsDir, { recursive: true, force: true }));

  it('parses a PRD fixture into the typed structure', async () => {
    writeFileSync(
      path.join(docsDir, 'PRD-0099-test-capability.md'),
      PRD_FIXTURE
    );

    const prd = await repo.getPrd('PRD-0099', docsDir);

    expect(prd.id).toBe('PRD-0099');
    expect(prd.title).toBe('Test Capability');
    expect(prd.status).toBe('Proposed');
    expect(prd.owner).toBe('Russ Watson');
    expect(prd.goals).toEqual([
      'Do the first thing end to end.',
      'Do the second thing across two lines.'
    ]);
    expect(prd.nonGoals).toEqual(['Do not boil the ocean.']);
    expect(prd.acceptanceCriteria).toEqual([
      'First observable condition.',
      'Second observable condition.'
    ]);
    expect(prd.rolloutPhases).toEqual([
      { number: 1, title: 'Walk', description: 'Ship the minimal loop.' },
      { number: 2, title: 'Run', description: 'Scale it out.' }
    ]);
  });

  it('produces a typed error for a missing PRD ID', async () => {
    await expect(repo.getPrd('PRD-0042', docsDir)).rejects.toMatchObject({
      name: 'WorkflowError',
      code: 'PRD_NOT_FOUND'
    });
  });

  it('produces a typed error for a missing docs directory', async () => {
    await expect(
      repo.getPrd('PRD-0099', path.join(docsDir, 'nope'))
    ).rejects.toMatchObject({ code: 'PRD_NOT_FOUND' });
  });

  it('produces a typed error for malformed frontmatter', async () => {
    writeFileSync(
      path.join(docsDir, 'PRD-0099-broken.md'),
      '# No frontmatter here\n'
    );
    await expect(repo.getPrd('PRD-0099', docsDir)).rejects.toMatchObject({
      code: 'PRD_MALFORMED'
    });
  });

  it('produces a typed error when frontmatter lacks id/title', async () => {
    writeFileSync(
      path.join(docsDir, 'PRD-0099-broken.md'),
      '---\ndate: 2026-07-31\n---\n# Body\n'
    );
    await expect(repo.getPrd('PRD-0099', docsDir)).rejects.toBeInstanceOf(
      WorkflowError
    );
  });
});
