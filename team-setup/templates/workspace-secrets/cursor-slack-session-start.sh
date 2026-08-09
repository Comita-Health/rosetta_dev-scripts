#!/usr/bin/env bash
# Cursor sessionStart hook — inject Slack credentials into the agent session.
#
# Reads ~/.config/__WORKSPACE__/slack.env and emits JSON Cursor understands:
#   { "env": { "SLACK_BOT_TOKEN": "...", ... } }
#
# Register in ~/.cursor/hooks.json under sessionStart (see workspace-agent-secrets.md).

set -euo pipefail

ENV_FILE="${WORKSPACE_SLACK_ENV:-$HOME/.config/__WORKSPACE__/slack.env}"

if [[ ! -f "$ENV_FILE" ]]; then
  printf '%s\n' '{}'
  exit 0
fi

# shellcheck disable=SC1090
set -a
source "$ENV_FILE"
set +a

node -e '
const keys = ["SLACK_BOT_TOKEN", "SLACK_CHANNEL_ID", "SLACK_SIGNING_SECRET"];
const env = {};
for (const k of keys) {
  const v = process.env[k];
  if (typeof v === "string" && v.trim().length > 0) env[k] = v;
}
process.stdout.write(JSON.stringify({ env }) + "\n");
'
