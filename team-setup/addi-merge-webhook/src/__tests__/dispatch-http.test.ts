import { createHmac } from 'node:crypto';
import type { HandlerRegistry } from '../composition.js';
import type { IWebhookHandler } from '../handlers/webhook.handler.js';
import { dispatchHttp } from '../utils/dispatch-http.js';

describe('dispatchHttp', () => {
  const secret = 's';
  const makeHandler = (): jest.Mocked<IWebhookHandler> => ({
    handleHttp: jest.fn().mockResolvedValue({
      status: 200,
      body: { ok: true, tenant: true }
    })
  });

  it('serves health', async () => {
    const registry: HandlerRegistry = {
      byTenant: new Map(),
      legacy: undefined
    };
    const res = await dispatchHttp(registry, {
      method: 'GET',
      pathname: '/health',
      rawBody: Buffer.alloc(0),
      signatureHeader: undefined,
      eventName: undefined
    });
    expect(res).toEqual({ status: 200, body: { ok: true } });
  });

  it('routes to the matching tenant handler', async () => {
    const acme = makeHandler();
    const registry: HandlerRegistry = {
      byTenant: new Map([['acme', acme]]),
      legacy: undefined
    };
    const rawBody = Buffer.from('{}');
    const sig = `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
    await dispatchHttp(registry, {
      method: 'POST',
      pathname: '/webhook/acme',
      rawBody,
      signatureHeader: sig,
      eventName: 'ping'
    });
    expect(acme.handleHttp).toHaveBeenCalled();
  });

  it('returns 404 when tenant is not configured', async () => {
    const registry: HandlerRegistry = {
      byTenant: new Map(),
      legacy: undefined
    };
    const res = await dispatchHttp(registry, {
      method: 'POST',
      pathname: '/webhook/rosetta',
      rawBody: Buffer.from('{}'),
      signatureHeader: 'sha256=ab',
      eventName: 'ping'
    });
    expect(res.status).toBe(404);
  });

  it('returns 404 for non-POST non-health methods', async () => {
    const registry: HandlerRegistry = {
      byTenant: new Map(),
      legacy: undefined
    };
    const res = await dispatchHttp(registry, {
      method: 'PUT',
      pathname: '/webhook/acme',
      rawBody: Buffer.alloc(0),
      signatureHeader: undefined,
      eventName: undefined
    });
    expect(res.status).toBe(404);
  });

  it('returns 404 for unconfigured tenant slugs', async () => {
    const registry: HandlerRegistry = {
      byTenant: new Map(),
      legacy: undefined
    };
    const res = await dispatchHttp(registry, {
      method: 'POST',
      pathname: '/webhook/unknown',
      rawBody: Buffer.from('{}'),
      signatureHeader: 'sha256=ab',
      eventName: 'ping'
    });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('tenant not configured: unknown');
  });

  it('routes legacy /webhook when configured', async () => {
    const legacy = makeHandler();
    const registry: HandlerRegistry = {
      byTenant: new Map(),
      legacy
    };
    await dispatchHttp(registry, {
      method: 'POST',
      pathname: '/webhook',
      rawBody: Buffer.from('{}'),
      signatureHeader: 'sha256=ab',
      eventName: 'ping'
    });
    expect(legacy.handleHttp).toHaveBeenCalled();
  });
});
