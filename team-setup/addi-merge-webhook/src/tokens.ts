export const ADDI_MERGE_WEBHOOK_TOKENS = {
  WebhookHandler: Symbol.for('WebhookHandler'),
  ReviewDispatchService: Symbol.for('ReviewDispatchService'),
  GitHubDispatchRepository: Symbol.for('GitHubDispatchRepository'),
  WebhookSecret: Symbol.for('WebhookSecret'),
  AppId: Symbol.for('AppId'),
  PrivateKeyPem: Symbol.for('PrivateKeyPem')
} as const;
