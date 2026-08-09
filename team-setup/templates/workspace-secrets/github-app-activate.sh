#!/usr/bin/env bash
# Usage: eval "$(bash ~/.config/__WORKSPACE__/github-app-activate.sh)"
# Scaffolded by team-setup scaffold-workspace-secrets.sh — do not commit secrets.

set -euo pipefail

CONFIG_DIR="$HOME/.config/__WORKSPACE__"
ENV_FILE="$CONFIG_DIR/github-app.env"
TOKEN_SCRIPT="$CONFIG_DIR/github-app-token.sh"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "github-app-activate: missing $ENV_FILE" >&2
  exit 1
fi
if [[ ! -x "$TOKEN_SCRIPT" && ! -f "$TOKEN_SCRIPT" ]]; then
  echo "github-app-activate: missing $TOKEN_SCRIPT" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

TOKEN=$(bash "$TOKEN_SCRIPT")
strip_q() {
  local v="$1"
  v="${v#\'}"
  v="${v%\'}"
  v="${v#\"}"
  v="${v%\"}"
  printf '%s' "$v"
}

NAME=$(strip_q "${GIT_AUTHOR_NAME}")
EMAIL=$(strip_q "${GIT_AUTHOR_EMAIL}")
printf 'export GH_TOKEN=%q\n' "$TOKEN"
printf 'export GITHUB_TOKEN=%q\n' "$TOKEN"
printf 'export GIT_AUTHOR_NAME=%q\n' "$NAME"
printf 'export GIT_AUTHOR_EMAIL=%q\n' "$EMAIL"
printf 'export GIT_COMMITTER_NAME=%q\n' "$(strip_q "${GIT_COMMITTER_NAME}")"
printf 'export GIT_COMMITTER_EMAIL=%q\n' "$(strip_q "${GIT_COMMITTER_EMAIL}")"
printf 'export GITHUB_APP_ID=%q\n' "$(strip_q "${GITHUB_APP_ID}")"
printf 'export GITHUB_APP_INSTALLATION_ID=%q\n' "$(strip_q "${GITHUB_APP_INSTALLATION_ID}")"
printf 'export GITHUB_APP_SLUG=%q\n' "$(strip_q "${GITHUB_APP_SLUG:-}")"
