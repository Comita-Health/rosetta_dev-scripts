import 'reflect-metadata';
import {
  SecretsManagerClient,
  GetSecretValueCommand
} from '@aws-sdk/client-secrets-manager';
import {
  loadHandlerRegistryFromEnv,
  loadHandlerRegistryFromSecretBundle,
  type HandlerRegistry,
  type SecretBundle
} from './composition.js';
import { dispatchHttp } from './utils/dispatch-http.js';
import type { FunctionUrlEvent, FunctionUrlResult } from './types.js';

let registryPromise: Promise<HandlerRegistry> | undefined;

const headerCI = (
  headers: Record<string, string | undefined> | undefined,
  name: string
): string | undefined => {
  if (headers === undefined) {
    return undefined;
  }
  const want = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === want) {
      return v;
    }
  }
  return undefined;
};

const loadRegistry = async (): Promise<HandlerRegistry> => {
  const secretArn = process.env.ADDI_MERGE_WEBHOOK_SECRET_ARN;
  if (secretArn !== undefined && secretArn.length > 0) {
    const client = new SecretsManagerClient({});
    const out = await client.send(
      new GetSecretValueCommand({ SecretId: secretArn })
    );
    if (out.SecretString === undefined || out.SecretString.length === 0) {
      throw new Error('Secret has no SecretString');
    }
    const bundle = JSON.parse(out.SecretString) as SecretBundle;
    return loadHandlerRegistryFromSecretBundle(bundle);
  }
  return loadHandlerRegistryFromEnv();
};

const getRegistry = (): Promise<HandlerRegistry> => {
  if (registryPromise === undefined) {
    registryPromise = loadRegistry();
  }
  return registryPromise;
};

const bodyToBuffer = (event: FunctionUrlEvent): Buffer => {
  if (
    event.body === undefined ||
    event.body === null ||
    event.body.length === 0
  ) {
    return Buffer.alloc(0);
  }
  if (event.isBase64Encoded === true) {
    return Buffer.from(event.body, 'base64');
  }
  return Buffer.from(event.body, 'utf8');
};

export const handler = async (
  event: FunctionUrlEvent
): Promise<FunctionUrlResult> => {
  const registry = await getRegistry();
  const method = event.requestContext.http.method;
  const pathname = event.rawPath.split('?')[0] ?? '/';

  try {
    const result = await dispatchHttp(registry, {
      method,
      pathname,
      rawBody: bodyToBuffer(event),
      signatureHeader: headerCI(event.headers, 'x-hub-signature-256'),
      eventName: headerCI(event.headers, 'x-github-event')
    });
    return {
      statusCode: result.status,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(result.body)
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(message);
    return {
      statusCode: 500,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ok: false, error: message })
    };
  }
};
