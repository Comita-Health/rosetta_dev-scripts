# addi-merge-webhook

Tiny HTTP bridge: **org / App webhook** → **`repository_dispatch`**
(`addi-merge-on-approve`) so Approve reliably starts
`.github/workflows/addi-merge-on-approve.yml`.

See [`../docs/addi-pr-automation-standard.md`](../docs/addi-pr-automation-standard.md).

## Why

Actions `pull_request_review` delivery is unreliable. Webhooks are reliable
but cannot start workflows directly — this bridge posts
`repository_dispatch` with `client_payload.pr_number`.

## Multi-tenant routes

Tenants are **config**, not code. Each configured slug gets
`POST /webhook/{tenant}`. Defaults ship Rosetta only:

| Org                | Path               | Credentials                               |
| ------------------ | ------------------ | ----------------------------------------- |
| Rosetta-Foundation | `/webhook/rosetta` | `rosetta-s-addi-m` / `~/.config/rosetta/` |

Add another consumer by extending `ADDI_TENANTS` / `ADDI_TENANT_ORGS` and
providing `${TENANT}_*` secrets — no source change.

Legacy single-tenant: `POST /webhook` with `ADDI_*` env vars.

## Run locally

```bash
cd team-setup/addi-merge-webhook
bun install
export ADDI_TENANTS=rosetta
export ROSETTA_WEBHOOK_SECRET='…'
export ROSETTA_CLIENT_ID='Iv23lifPkkooMoMiz5Jk'
export ROSETTA_APP_PRIVATE_KEY_PATH="$HOME/.config/rosetta/github-app.pem"
export PORT=8787
bun run dev
```

## Deploy (AWS Lambda Function URL)

Requires `AWS_PROFILE` (no default). Stores PEM + webhook secrets in Secrets
Manager (`addi/merge-webhook`), creates/updates Lambda `addi-merge-webhook`
with a public Function URL, then upserts **org** webhooks for each entry in
`ADDI_TENANT_ORGS` (default `rosetta:Rosetta-Foundation`):

```bash
AWS_PROFILE=<your-profile> bun run deploy
# or: AWS_PROFILE=<your-profile> bash deploy/deploy.sh
```

After deploy:

- Health: `GET https://<url-id>.lambda-url.<region>.on.aws/health`
- Live URL is written to `~/.config/rosetta/addi-merge-webhook.url`
- Org hooks subscribe to **`pull_request_review`** only

## Bridge duties

1. Verify `X-Hub-Signature-256` with the per-tenant webhook secret.
2. On `pull_request_review` + `action=submitted` + `review.state=approved`,
   mint an installation token and
   `POST /repos/{owner}/{repo}/dispatches` with
   `event_type=addi-merge-on-approve` and `client_payload.pr_number`.

## Health

`GET /health` → `{ "ok": true }`
