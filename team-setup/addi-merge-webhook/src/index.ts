import 'reflect-metadata';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse
} from 'node:http';
import { readFileSync } from 'node:fs';
import { Container } from 'inversify';
import { ADDI_MERGE_WEBHOOK_TOKENS } from './tokens.js';
import {
  GitHubDispatchRepository,
  type IGitHubDispatchRepository
} from './repositories/github-dispatch.repository.js';
import {
  ReviewDispatchService,
  type IReviewDispatchService
} from './services/review-dispatch.service.js';
import {
  WebhookHandler,
  type IWebhookHandler
} from './handlers/webhook.handler.js';

const requireEnv = (name: string): string => {
  const v = process.env[name];
  if (v === undefined || v.length === 0) {
    throw new Error(`Missing required env ${name}`);
  }
  return v;
};

const readBody = (req: IncomingMessage): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });

const privateKeyPem = (): string => {
  const inline = process.env.ADDI_APP_PRIVATE_KEY;
  if (inline !== undefined && inline.length > 0) {
    return inline.replace(/\\n/g, '\n');
  }
  const path = process.env.ADDI_APP_PRIVATE_KEY_PATH;
  if (path === undefined || path.length === 0) {
    throw new Error('Set ADDI_APP_PRIVATE_KEY or ADDI_APP_PRIVATE_KEY_PATH');
  }
  return readFileSync(path, 'utf8');
};

const container = new Container();
container
  .bind<string>(ADDI_MERGE_WEBHOOK_TOKENS.WebhookSecret)
  .toConstantValue(requireEnv('ADDI_WEBHOOK_SECRET'));
container
  .bind<string>(ADDI_MERGE_WEBHOOK_TOKENS.AppId)
  .toConstantValue(process.env.ADDI_CLIENT_ID ?? requireEnv('ADDI_APP_ID'));
container
  .bind<string>(ADDI_MERGE_WEBHOOK_TOKENS.PrivateKeyPem)
  .toConstantValue(privateKeyPem());
container
  .bind<IGitHubDispatchRepository>(
    ADDI_MERGE_WEBHOOK_TOKENS.GitHubDispatchRepository
  )
  .to(GitHubDispatchRepository);
container
  .bind<IReviewDispatchService>(ADDI_MERGE_WEBHOOK_TOKENS.ReviewDispatchService)
  .to(ReviewDispatchService);
container
  .bind<IWebhookHandler>(ADDI_MERGE_WEBHOOK_TOKENS.WebhookHandler)
  .to(WebhookHandler);

const handler = container.get<IWebhookHandler>(
  ADDI_MERGE_WEBHOOK_TOKENS.WebhookHandler
);

const port = Number(process.env.PORT ?? '8787');

const server = createServer(
  async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (req.method !== 'POST' || req.url !== '/webhook') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'not found' }));
      return;
    }

    try {
      const rawBody = await readBody(req);
      const result = await handler.handleHttp({
        rawBody,
        signatureHeader: req.headers['x-hub-signature-256'] as
          string | undefined,
        eventName: req.headers['x-github-event'] as string | undefined
      });
      res.writeHead(result.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result.body));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: message }));
    }
  }
);

server.listen(port, () => {
  console.log(`addi-merge-webhook listening on :${port}`);
});
