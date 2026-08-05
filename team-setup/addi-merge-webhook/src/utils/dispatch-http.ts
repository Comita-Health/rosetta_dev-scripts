import type { IWebhookHandler } from '../handlers/webhook.handler.js';
import type { HandlerRegistry } from '../composition.js';
import { parseWebhookTenant } from './parse-tenant-path.js';

export type HttpDispatchInput = {
  method: string;
  pathname: string;
  rawBody: Buffer;
  signatureHeader: string | undefined;
  eventName: string | undefined;
};

export type HttpDispatchOutput = {
  status: number;
  body: Record<string, unknown>;
};

export const dispatchHttp = async (
  registry: HandlerRegistry,
  input: HttpDispatchInput
): Promise<HttpDispatchOutput> => {
  if (input.method === 'GET' && input.pathname === '/health') {
    return { status: 200, body: { ok: true } };
  }

  if (input.method !== 'POST') {
    return { status: 404, body: { ok: false, error: 'not found' } };
  }

  const tenant = parseWebhookTenant(input.pathname);
  if (tenant === null) {
    return { status: 404, body: { ok: false, error: 'not found' } };
  }

  let handler: IWebhookHandler | undefined;
  if (tenant === 'legacy') {
    handler = registry.legacy;
  } else {
    handler = registry.byTenant.get(tenant);
  }

  if (handler === undefined) {
    return {
      status: 404,
      body: { ok: false, error: `tenant not configured: ${tenant}` }
    };
  }

  return handler.handleHttp({
    rawBody: input.rawBody,
    signatureHeader: input.signatureHeader,
    eventName: input.eventName
  });
};
