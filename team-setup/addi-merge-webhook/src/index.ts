import 'reflect-metadata';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse
} from 'node:http';
import { loadHandlerRegistryFromEnv } from './composition.js';
import { dispatchHttp } from './utils/dispatch-http.js';

const readBody = (req: IncomingMessage): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });

const registry = loadHandlerRegistryFromEnv();
const port = Number(process.env.PORT ?? '8787');

const server = createServer(
  async (req: IncomingMessage, res: ServerResponse) => {
    const pathname = (req.url ?? '/').split('?')[0] ?? '/';
    try {
      const rawBody =
        req.method === 'POST' ? await readBody(req) : Buffer.alloc(0);
      const result = await dispatchHttp(registry, {
        method: req.method ?? 'GET',
        pathname,
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
  const tenants = [...registry.byTenant.keys()].join(', ') || '(none)';
  const legacy = registry.legacy !== undefined ? 'yes' : 'no';
  console.log(
    `addi-merge-webhook listening on :${port} tenants=[${tenants}] legacy=${legacy}`
  );
});
