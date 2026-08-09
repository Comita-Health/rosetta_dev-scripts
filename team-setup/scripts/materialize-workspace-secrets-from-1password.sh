#!/usr/bin/env bash
# Resolve 1Password secret-reference templates into ~/.config/<workspace>/*.env
# (and optionally the GitHub App PEM). Never prints secret values.
#
# Prerequisites: 1Password CLI (`op`), signed in; vault access for the refs
# in ~/.config/<workspace>/op/*.tpl (edit vault/item names after scaffold).
#
# Usage:
#   bash team-setup/scripts/materialize-workspace-secrets-from-1password.sh \
#     --workspace comita
#   bash … --workspace comita --slack-only
#   bash … --workspace comita --github-only --pem-ref \
#     'op://Private/Agent GitHub App/private_key'

set -euo pipefail

WORKSPACE=""
CONFIG_HOME="${HOME}/.config"
SLACK_ONLY=0
GITHUB_ONLY=0
PEM_REF=""
FORCE=0

usage() {
  sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --workspace)
      WORKSPACE="${2:-}"
      shift 2
      ;;
    --config-home)
      CONFIG_HOME="${2:-}"
      shift 2
      ;;
    --slack-only)
      SLACK_ONLY=1
      shift
      ;;
    --github-only)
      GITHUB_ONLY=1
      shift
      ;;
    --pem-ref)
      PEM_REF="${2:-}"
      shift 2
      ;;
    --force)
      FORCE=1
      shift
      ;;
    -h | --help)
      usage 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage 1
      ;;
  esac
done

if [[ -z "$WORKSPACE" ]]; then
  echo "error: --workspace is required" >&2
  usage 1
fi

if ! command -v op >/dev/null 2>&1; then
  echo "error: 1Password CLI (op) not found. Install: https://developer.1password.com/docs/cli/get-started/" >&2
  exit 1
fi

TARGET_DIR="${CONFIG_HOME}/${WORKSPACE}"
OP_DIR="${TARGET_DIR}/op"

if [[ ! -d "$OP_DIR" ]]; then
  echo "error: missing $OP_DIR — run scaffold-workspace-secrets.sh first" >&2
  exit 1
fi

inject_file() {
  local tpl="$1"
  local out="$2"
  if [[ ! -f "$tpl" ]]; then
    echo "error: missing template $tpl" >&2
    exit 1
  fi
  if [[ -f "$out" && "$FORCE" -ne 1 ]]; then
    echo "  keep  $out (exists; pass --force to re-inject)"
    return 0
  fi
  # op inject --file-mode is supported on modern CLI; fall back to chmod.
  if op inject --help 2>&1 | grep -q -- '--file-mode'; then
    op inject -i "$tpl" -o "$out" --file-mode 0600
  else
    op inject -i "$tpl" -o "$out"
    chmod 600 "$out"
  fi
  echo "  wrote $out (mode 600; values not shown)"
}

do_slack=1
do_github=1
if [[ "$SLACK_ONLY" -eq 1 ]]; then
  do_github=0
fi
if [[ "$GITHUB_ONLY" -eq 1 ]]; then
  do_slack=0
fi

echo "Materializing secrets for workspace=${WORKSPACE} (via op inject)"

if [[ "$do_slack" -eq 1 ]]; then
  inject_file "${OP_DIR}/slack.env.tpl" "${TARGET_DIR}/slack.env"
fi

if [[ "$do_github" -eq 1 ]]; then
  inject_file "${OP_DIR}/github-app.env.tpl" "${TARGET_DIR}/github-app.env"
  # Rewrite __WORKSPACE__ if the tpl still had a literal (scaffold should have fixed it)
  if [[ -f "${TARGET_DIR}/github-app.env" ]]; then
    sed -i.bak "s/__WORKSPACE__/${WORKSPACE}/g" "${TARGET_DIR}/github-app.env"
    rm -f "${TARGET_DIR}/github-app.env.bak"
    chmod 600 "${TARGET_DIR}/github-app.env"
  fi
fi

if [[ -n "$PEM_REF" ]]; then
  pem_out="${TARGET_DIR}/github-app.pem"
  if [[ -f "$pem_out" && "$FORCE" -ne 1 ]]; then
    echo "  keep  $pem_out (exists; pass --force to replace)"
  else
    op read "$PEM_REF" --out-file "$pem_out"
    chmod 600 "$pem_out"
    echo "  wrote $pem_out (mode 600; values not shown)"
  fi
fi

echo "Done. Run verify-workspace-secrets.sh next."
