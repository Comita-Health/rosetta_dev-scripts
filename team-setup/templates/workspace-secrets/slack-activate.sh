#!/usr/bin/env bash
# Export workspace Slack credentials into the current shell.
#
# Usage:
#   eval "$(bash ~/.config/__WORKSPACE__/slack-activate.sh)"

set -euo pipefail

ENV_FILE="${WORKSPACE_SLACK_ENV:-$HOME/.config/__WORKSPACE__/slack.env}"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "slack-activate: missing $ENV_FILE" >&2
  exit 1
fi

# shellcheck disable=SC1090
set -a
source "$ENV_FILE"
set +a

for key in SLACK_BOT_TOKEN SLACK_CHANNEL_ID SLACK_SIGNING_SECRET; do
  if [[ -n "${!key:-}" ]]; then
    printf 'export %s=%q\n' "$key" "${!key}"
  fi
done
