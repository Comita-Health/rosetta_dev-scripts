export type PullRequestReviewWebhook = {
  action: string;
  review: { state: string };
  pull_request: { number: number };
  repository: { full_name: string; name: string; owner: { login: string } };
};

export type DispatchResult =
  | { kind: 'dispatched'; repo: string; prNumber: number }
  | { kind: 'ignored'; reason: string };
