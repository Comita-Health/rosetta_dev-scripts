import 'reflect-metadata';
import { generateKeyPairSync } from 'node:crypto';
import { Container } from 'inversify';
import { ADDI_MERGE_WEBHOOK_TOKENS } from '../tokens.js';
import { GitHubDispatchRepository } from '../repositories/github-dispatch.repository.js';

describe('GitHubDispatchRepository', () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
  let repo: GitHubDispatchRepository;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    const container = new Container();
    container.bind(ADDI_MERGE_WEBHOOK_TOKENS.AppId).toConstantValue('Iv23test');
    container
      .bind(ADDI_MERGE_WEBHOOK_TOKENS.PrivateKeyPem)
      .toConstantValue(pem);
    container
      .bind(ADDI_MERGE_WEBHOOK_TOKENS.GitHubDispatchRepository)
      .to(GitHubDispatchRepository);
    repo = container.get(ADDI_MERGE_WEBHOOK_TOKENS.GitHubDispatchRepository);
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  it('mints an installation token and posts repository_dispatch', async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 99 })
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ token: 'ghs_test' })
      })
      .mockResolvedValueOnce({
        status: 204,
        text: async () => ''
      });

    await repo.dispatchAddiMerge('Comita-Health', 'comita_admissions', 18);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const dispatchCall = fetchMock.mock.calls[2];
    expect(dispatchCall[0]).toBe(
      'https://api.github.com/repos/Comita-Health/comita_admissions/dispatches'
    );
    expect(JSON.parse(dispatchCall[1].body as string)).toEqual({
      event_type: 'addi-merge-on-approve',
      client_payload: { pr_number: '18' }
    });
    expect(dispatchCall[1].headers.Authorization).toBe('Bearer ghs_test');
  });

  it('throws when repository_dispatch fails', async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 1 })
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ token: 'ghs_x' })
      })
      .mockResolvedValueOnce({
        status: 422,
        text: async () => 'bad'
      });

    await expect(repo.dispatchAddiMerge('o', 'r', 1)).rejects.toThrow(
      /repository_dispatch failed/
    );
  });

  it('throws when installation lookup fails', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 404 });
    await expect(repo.dispatchAddiMerge('o', 'r', 1)).rejects.toThrow(
      /Failed to resolve installation/
    );
  });
});
