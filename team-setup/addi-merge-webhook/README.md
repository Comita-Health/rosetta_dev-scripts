# addi-merge-webhook

Tiny HTTP bridge: **org / App webhook** → **`repository_dispatch`**
(`addi-merge-on-approve`) so Approve reliably starts
`.github/workflows/addi-merge-on-approve.yml`.

See [`../docs/addi-pr-automation-standard.md`](../docs/addi-pr-automation-standard.md).

## Why

Actions `pull_request_review` delivery is unreliable. Webhooks are reliable
but cannot start workflows directly — this bridge posts
`repository_dispatch` with `client_payload.pr_number`.

## Dual-org routes

| Org                | Path               | App / credentials                         |
| ------------------ | ------------------ | ----------------------------------------- |
| Rosetta-Foundation | `/webhook/rosetta` | `rosetta-s-addi-m` / `~/.config/rosetta/` |
| Comita-Health      | `/webhook/comita`  | `addi-m` / `~/.config/comita/`            |

Legacy single-tenant: `POST /webhook` with `ADDI_*` env vars.

## Run locally

```bash
cd team-setup/addi-merge-webhook
bun install
export ROSETTA_WEBHOOK_SECRET='…'
export ROSETTA_CLIENT_ID='Iv23lifPkkooMoMiz5Jk'
export ROSETTA_APP_PRIVATE_KEY_PATH="$HOME/.config/rosetta/github-app.pem"
export COMITA_WEBHOOK_SECRET='…'
export COMITA_CLIENT_ID='Iv23li7Ascc7UNomoH8S'
export COMITA_APP_PRIVATE_KEY_PATH="$HOME/.config/comita/github-app.pem"
export PORT=8787
bun run dev
```

## Deploy (AWS Lambda Function URL)

Uses AWS profile `comita-dev` (account hosting Comita workloads). Stores PEM +
webhook secrets in Secrets Manager (`addi/merge-webhook`), creates/updates
Lambda `addi-merge-webhook` with a public Function URL, then upserts **org**
webhooks (App webhooks are inactive until toggled in the UI; org hooks work
today via `organization_hooks: write`):

```bash
bun run deploy
# or: AWS_PROFILE=comita-dev bash deploy/deploy.sh
```

After deploy:

- Health: `GET https://<url-id>.lambda-url.us-east-1.on.aws/health`
- Live URL is also written to `~/.config/comita/addi-merge-webhook.url`
- Org hooks subscribe to **`pull_request_review`** only

**Current production URL** (`comita-dev` / `us-east-1`):

`https://kfjifzn4cza53dmr4xqdcrgk4m0ugopm.lambda-url.us-east-1.on.aws`

## Bridge duties

1. Verify `X-Hub-Signature-256` with the per-tenant webhook secret.
2. On `pull_request_review` + `action=submitted` + `review.state=approved`,
   mint an installation token and
   `POST /repos/{owner}/{repo}/dispatches` with
   `event_type=addi-merge-on-approve` and `client_payload.pr_number`.

## Health

`GET /health` → `{ "ok": true }`
