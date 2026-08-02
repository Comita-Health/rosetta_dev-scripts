# addi-merge-webhook

Tiny HTTP bridge: **GitHub App webhook** → **`repository_dispatch`**
(`addi-merge-on-approve`) so Approve reliably starts
`.github/workflows/addi-merge-on-approve.yml`.

See [`../docs/addi-pr-automation-standard.md`](../docs/addi-pr-automation-standard.md).

## Why

Actions `pull_request_review` delivery is unreliable. App webhooks are reliable
but cannot start workflows directly — this bridge posts
`repository_dispatch` with `client_payload.pr_number`.

## Run locally (Tailscale / tunnel)

```bash
cd team-setup/addi-merge-webhook
bun install   # or npm/bun from package manager policy
export ADDI_WEBHOOK_SECRET='…'          # App webhook secret
export ADDI_CLIENT_ID='Iv23…'           # preferred JWT iss / app id
# or: export ADDI_APP_ID='4464370'
export ADDI_APP_PRIVATE_KEY_PATH="$HOME/.config/rosetta/github-app.pem"
# Comita: ~/.config/comita/github-app.pem + Comita client id
export PORT=8787
bun run dev
```

Expose `https://<host>/webhook` to the public internet (Tailscale Funnel,
Cloudflare Tunnel, etc.).

## GitHub App settings

1. Webhook URL: `https://<host>/webhook`
2. Webhook secret: same as `ADDI_WEBHOOK_SECRET`
3. Subscribe to **Pull request reviews**
4. Permissions: contents read, metadata, pull requests read (dispatch uses
   installation token with contents:write via Actions separately)

## Deploy notes

- Comita already runs workloads on AWS — API Gateway + Lambda (or a small
  always-on host) is fine.
- Rosetta may use the same bridge binary behind a tunnel, or GitHub’s unofficial
  [event-mirror Azure Function](https://github.com/github/github-event-mirror-azure-function)
  filtered to `pull_request_review`.

## Health

`GET /health` → `{ "ok": true }`
