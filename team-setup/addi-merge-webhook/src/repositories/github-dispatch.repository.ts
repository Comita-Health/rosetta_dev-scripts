import { createSign } from 'node:crypto';
import { injectable, inject } from 'inversify';
import { ADDI_MERGE_WEBHOOK_TOKENS } from '../tokens.js';

export interface IGitHubDispatchRepository {
  dispatchAddiMerge(
    owner: string,
    repo: string,
    prNumber: number
  ): Promise<void>;
}

@injectable()
export class GitHubDispatchRepository implements IGitHubDispatchRepository {
  constructor(
    @inject(ADDI_MERGE_WEBHOOK_TOKENS.AppId)
    private readonly _appId: string,
    @inject(ADDI_MERGE_WEBHOOK_TOKENS.PrivateKeyPem)
    private readonly _privateKeyPem: string
  ) {}

  async dispatchAddiMerge(
    owner: string,
    repo: string,
    prNumber: number
  ): Promise<void> {
    const jwt = this._mintAppJwt();
    const installationId = await this._resolveInstallationId(jwt, owner, repo);
    const token = await this._mintInstallationToken(jwt, installationId);

    const res = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/dispatches`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'addi-merge-webhook',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          event_type: 'addi-merge-on-approve',
          client_payload: { pr_number: String(prNumber) }
        })
      }
    );

    if (res.status !== 204) {
      const body = await res.text();
      throw new Error(
        `repository_dispatch failed (${res.status}) for ${owner}/${repo}#${prNumber}: ${body}`
      );
    }
  }

  private _mintAppJwt(): string {
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(
      JSON.stringify({ alg: 'RS256', typ: 'JWT' })
    ).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({
        iat: now - 60,
        exp: now + 540,
        iss: this._appId
      })
    ).toString('base64url');
    const data = `${header}.${payload}`;
    const sign = createSign('RSA-SHA256');
    sign.update(data);
    sign.end();
    const sig = sign.sign(this._privateKeyPem, 'base64url');
    return `${data}.${sig}`;
  }

  private async _resolveInstallationId(
    jwt: string,
    owner: string,
    repo: string
  ): Promise<number> {
    const res = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/installation`,
      {
        headers: {
          Authorization: `Bearer ${jwt}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'addi-merge-webhook'
        }
      }
    );
    if (!res.ok) {
      throw new Error(
        `Failed to resolve installation for ${owner}/${repo}: ${res.status}`
      );
    }
    const json = (await res.json()) as { id: number };
    return json.id;
  }

  private async _mintInstallationToken(
    jwt: string,
    installationId: number
  ): Promise<string> {
    const res = await fetch(
      `https://api.github.com/app/installations/${installationId}/access_tokens`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${jwt}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'addi-merge-webhook'
        }
      }
    );
    if (!res.ok) {
      throw new Error(`Failed to mint installation token: ${res.status}`);
    }
    const json = (await res.json()) as { token: string };
    return json.token;
  }
}
