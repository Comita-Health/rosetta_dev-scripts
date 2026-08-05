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
import type { TenantConfig, TenantId } from './types.js';

const requireEnv = (name: string): string => {
  const v = process.env[name];
  if (v === undefined || v.length === 0) {
    throw new Error(`Missing required env ${name}`);
  }
  return v;
};

const normalizePem = (pem: string): string => pem.replace(/\\n/g, '\n');

const readPemFromEnv = (
  inlineName: string,
  pathName: string
): string | undefined => {
  const inline = process.env[inlineName];
  if (inline !== undefined && inline.length > 0) {
    return normalizePem(inline);
  }
  const path = process.env[pathName];
  if (path !== undefined && path.length > 0) {
    return readFileSync(path, 'utf8');
  }
  return undefined;
};

export const createWebhookHandler = (config: TenantConfig): IWebhookHandler => {
  const container = new Container();
  container
    .bind<string>(ADDI_MERGE_WEBHOOK_TOKENS.WebhookSecret)
    .toConstantValue(config.webhookSecret);
  container
    .bind<string>(ADDI_MERGE_WEBHOOK_TOKENS.AppId)
    .toConstantValue(config.clientId);
  container
    .bind<string>(ADDI_MERGE_WEBHOOK_TOKENS.PrivateKeyPem)
    .toConstantValue(config.privateKeyPem);
  container
    .bind<IGitHubDispatchRepository>(
      ADDI_MERGE_WEBHOOK_TOKENS.GitHubDispatchRepository
    )
    .to(GitHubDispatchRepository);
  container
    .bind<IReviewDispatchService>(
      ADDI_MERGE_WEBHOOK_TOKENS.ReviewDispatchService
    )
    .to(ReviewDispatchService);
  container
    .bind<IWebhookHandler>(ADDI_MERGE_WEBHOOK_TOKENS.WebhookHandler)
    .to(WebhookHandler);
  return container.get<IWebhookHandler>(
    ADDI_MERGE_WEBHOOK_TOKENS.WebhookHandler
  );
};

export type HandlerRegistry = {
  byTenant: Map<TenantId, IWebhookHandler>;
  legacy: IWebhookHandler | undefined;
};

const tenantFromPrefixedEnv = (tenant: TenantId): TenantConfig | undefined => {
  const prefix = tenant.toUpperCase();
  const webhookSecret = process.env[`${prefix}_WEBHOOK_SECRET`];
  const clientId = process.env[`${prefix}_CLIENT_ID`];
  const privateKeyPem = readPemFromEnv(
    `${prefix}_APP_PRIVATE_KEY`,
    `${prefix}_APP_PRIVATE_KEY_PATH`
  );
  if (
    webhookSecret === undefined ||
    webhookSecret.length === 0 ||
    clientId === undefined ||
    clientId.length === 0 ||
    privateKeyPem === undefined
  ) {
    return undefined;
  }
  return { id: tenant, webhookSecret, clientId, privateKeyPem };
};

const legacyFromEnv = (): TenantConfig | undefined => {
  const webhookSecret = process.env.ADDI_WEBHOOK_SECRET;
  if (webhookSecret === undefined || webhookSecret.length === 0) {
    return undefined;
  }
  const clientId = process.env.ADDI_CLIENT_ID ?? process.env.ADDI_APP_ID;
  if (clientId === undefined || clientId.length === 0) {
    throw new Error('Set ADDI_CLIENT_ID or ADDI_APP_ID for legacy /webhook');
  }
  const privateKeyPem = readPemFromEnv(
    'ADDI_APP_PRIVATE_KEY',
    'ADDI_APP_PRIVATE_KEY_PATH'
  );
  if (privateKeyPem === undefined) {
    throw new Error(
      'Set ADDI_APP_PRIVATE_KEY or ADDI_APP_PRIVATE_KEY_PATH for legacy /webhook'
    );
  }
  return {
    id: 'legacy',
    webhookSecret,
    clientId,
    privateKeyPem
  };
};

/** Tenant ids to load from `${ID}_*` env prefixes (default: rosetta only). */
export const tenantIdsFromEnv = (): TenantId[] => {
  const raw = process.env.ADDI_TENANTS ?? 'rosetta';
  return raw
    .split(',')
    .map(s => s.trim())
    .filter(s => s.length > 0);
};

/** Load tenant handlers from process env (local / prefixed). */
export const loadHandlerRegistryFromEnv = (): HandlerRegistry => {
  const byTenant = new Map<TenantId, IWebhookHandler>();
  for (const id of tenantIdsFromEnv()) {
    const cfg = tenantFromPrefixedEnv(id);
    if (cfg !== undefined) {
      byTenant.set(id, createWebhookHandler(cfg));
    }
  }
  const legacyCfg = legacyFromEnv();
  const legacy =
    legacyCfg !== undefined ? createWebhookHandler(legacyCfg) : undefined;

  if (byTenant.size === 0 && legacy === undefined) {
    throw new Error(
      'No tenants configured. Set ADDI_TENANTS with matching ${TENANT}_* env vars, or ADDI_* for legacy /webhook.'
    );
  }
  return { byTenant, legacy };
};

export type SecretBundle = {
  tenants: Record<
    string,
    {
      webhookSecret: string;
      clientId: string;
      privateKey: string;
    }
  >;
};

export const loadHandlerRegistryFromSecretBundle = (
  bundle: SecretBundle
): HandlerRegistry => {
  const byTenant = new Map<TenantId, IWebhookHandler>();
  for (const id of Object.keys(bundle.tenants)) {
    const t = bundle.tenants[id];
    if (t === undefined) {
      continue;
    }
    byTenant.set(
      id,
      createWebhookHandler({
        id,
        webhookSecret: t.webhookSecret,
        clientId: t.clientId,
        privateKeyPem: normalizePem(t.privateKey)
      })
    );
  }
  if (byTenant.size === 0) {
    throw new Error('Secret bundle contained no tenants');
  }
  return { byTenant, legacy: undefined };
};

/** Used only when forcing a single required env (tests / fail-fast helpers). */
export const requireEnvExport = requireEnv;
