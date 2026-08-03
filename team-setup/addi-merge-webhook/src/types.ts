export type TenantId = 'rosetta' | 'comita';

export type TenantConfig = {
  id: TenantId;
  webhookSecret: string;
  clientId: string;
  privateKeyPem: string;
};

export type PullRequestReviewWebhook = {
  action: string;
  review: { state: string };
  pull_request: { number: number };
  repository: { full_name: string; name: string; owner: { login: string } };
};

export type DispatchResult =
  | { kind: 'dispatched'; repo: string; prNumber: number }
  | { kind: 'ignored'; reason: string };

/** API Gateway / Lambda Function URL payload format 2.0 (subset). */
export type FunctionUrlEvent = {
  version: string;
  rawPath: string;
  headers?: Record<string, string | undefined>;
  body?: string | null;
  isBase64Encoded?: boolean;
  requestContext: {
    http: {
      method: string;
      path: string;
    };
  };
};

export type FunctionUrlResult = {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
};
