#!/usr/bin/env bash
# Scaffold ~/.config/<workspace>/ agent automation files (no secret values).
#
# Usage:
#   bash team-setup/scripts/scaffold-workspace-secrets.sh --workspace comita
#   bash team-setup/scripts/scaffold-workspace-secrets.sh --workspace rosetta \
#     --config-home /tmp/fake-home/.config
#
# Options:
#   --workspace NAME     Required. Directory under ~/.config (e.g. comita, rosetta).
#   --config-home DIR    Override $HOME/.config (tests / alternate layouts).
#   --cursor-hooks-dir   Override ~/.cursor/hooks for the Slack sessionStart copy.
#   --register-cursor-hook  Patch ~/.cursor/hooks.json sessionStart entry (best-effort).
#   --force              Overwrite existing scaffolded scripts (never overwrites *.env / *.pem).
#   --print-next-steps   Always print the human checklist (default on).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATES_DIR="$(cd "$SCRIPT_DIR/../templates/workspace-secrets" && pwd)"

WORKSPACE=""
CONFIG_HOME="${HOME}/.config"
CURSOR_HOOKS_DIR="${HOME}/.cursor/hooks"
CURSOR_HOOKS_JSON="${HOME}/.cursor/hooks.json"
REGISTER_CURSOR_HOOK=0
FORCE=0
PRINT_NEXT=1

usage() {
  sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'
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
    --cursor-hooks-dir)
      CURSOR_HOOKS_DIR="${2:-}"
      shift 2
      ;;
    --hooks-json)
      CURSOR_HOOKS_JSON="${2:-}"
      shift 2
      ;;
    --register-cursor-hook)
      REGISTER_CURSOR_HOOK=1
      shift
      ;;
    --force)
      FORCE=1
      shift
      ;;
    --print-next-steps)
      PRINT_NEXT=1
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
  echo "error: --workspace is required (e.g. comita, rosetta)" >&2
  usage 1
fi

if [[ ! "$WORKSPACE" =~ ^[a-zA-Z0-9][a-zA-Z0-9_-]*$ ]]; then
  echo "error: --workspace must be alphanumeric / _ / -" >&2
  exit 1
fi

if [[ ! -d "$TEMPLATES_DIR" ]]; then
  echo "error: templates missing at $TEMPLATES_DIR" >&2
  exit 1
fi

TARGET_DIR="${CONFIG_HOME}/${WORKSPACE}"
mkdir -p "$TARGET_DIR"
chmod 700 "$TARGET_DIR" 2>/dev/null || true

substitute() {
  local src="$1"
  local dest="$2"
  local mode="$3"
  if [[ -e "$dest" && "$FORCE" -ne 1 ]]; then
    echo "  keep  $dest (exists; pass --force to replace scripts)"
    return 0
  fi
  # Never clobber real secret material even with --force.
  case "$(basename "$dest")" in
    *.env | *.pem)
      if [[ -e "$dest" ]]; then
        echo "  keep  $dest (secret file — never overwritten by scaffold)"
        return 0
      fi
      ;;
  esac
  sed "s/__WORKSPACE__/${WORKSPACE}/g" "$src" >"$dest"
  chmod "$mode" "$dest"
  echo "  write $dest"
}

echo "Scaffolding workspace secrets layout → $TARGET_DIR"

substitute "$TEMPLATES_DIR/github-app-activate.sh" \
  "$TARGET_DIR/github-app-activate.sh" 700
substitute "$TEMPLATES_DIR/github-app-token.sh" \
  "$TARGET_DIR/github-app-token.sh" 700
substitute "$TEMPLATES_DIR/slack-activate.sh" \
  "$TARGET_DIR/slack-activate.sh" 700

# Example / empty env templates (only if missing)
if [[ ! -f "$TARGET_DIR/github-app.env" ]]; then
  substitute "$TEMPLATES_DIR/github-app.env.example" \
    "$TARGET_DIR/github-app.env.example" 600
fi
if [[ ! -f "$TARGET_DIR/slack.env" && ! -f "$TARGET_DIR/slack.env.example" ]]; then
  substitute "$TEMPLATES_DIR/slack.env.example" \
    "$TARGET_DIR/slack.env.example" 600
fi

# Copy 1Password templates for local editing of vault paths
mkdir -p "$TARGET_DIR/op"
if [[ ! -f "$TARGET_DIR/op/slack.env.tpl" || "$FORCE" -eq 1 ]]; then
  sed "s/__WORKSPACE__/${WORKSPACE}/g" \
    "$TEMPLATES_DIR/op/slack.env.tpl" >"$TARGET_DIR/op/slack.env.tpl"
  chmod 600 "$TARGET_DIR/op/slack.env.tpl"
  echo "  write $TARGET_DIR/op/slack.env.tpl"
else
  echo "  keep  $TARGET_DIR/op/slack.env.tpl"
fi
if [[ ! -f "$TARGET_DIR/op/github-app.env.tpl" || "$FORCE" -eq 1 ]]; then
  sed "s/__WORKSPACE__/${WORKSPACE}/g" \
    "$TEMPLATES_DIR/op/github-app.env.tpl" >"$TARGET_DIR/op/github-app.env.tpl"
  chmod 600 "$TARGET_DIR/op/github-app.env.tpl"
  echo "  write $TARGET_DIR/op/github-app.env.tpl"
else
  echo "  keep  $TARGET_DIR/op/github-app.env.tpl"
fi

# Cursor sessionStart helper (user-level hooks dir)
mkdir -p "$CURSOR_HOOKS_DIR"
HOOK_DEST="${CURSOR_HOOKS_DIR}/${WORKSPACE}-slack-session-start.sh"
substitute "$TEMPLATES_DIR/cursor-slack-session-start.sh" "$HOOK_DEST" 700

if [[ "$REGISTER_CURSOR_HOOK" -eq 1 ]]; then
  if ! command -v node >/dev/null 2>&1; then
    echo "  warn  node required to register Cursor hook; skipped" >&2
  else
    HOOK_DEST="$HOOK_DEST" HOOKS_JSON="$CURSOR_HOOKS_JSON" node <<'NODE'
const fs = require('fs');
const path = require('path');
const hooksPath = process.env.HOOKS_JSON;
const command = process.env.HOOK_DEST;
let doc = { version: 1, hooks: {} };
if (fs.existsSync(hooksPath)) {
  try {
    doc = JSON.parse(fs.readFileSync(hooksPath, 'utf8'));
  } catch (err) {
    console.error('  warn  could not parse hooks.json; left unchanged');
    process.exit(0);
  }
}
if (typeof doc.version !== 'number') doc.version = 1;
if (!doc.hooks || typeof doc.hooks !== 'object') doc.hooks = {};
const list = Array.isArray(doc.hooks.sessionStart) ? doc.hooks.sessionStart : [];
const already = list.some((e) => e && e.command === command);
if (!already) {
  list.push({ command });
  doc.hooks.sessionStart = list;
  fs.mkdirSync(path.dirname(hooksPath), { recursive: true });
  fs.writeFileSync(hooksPath, JSON.stringify(doc, null, 2) + '\n', { mode: 0o600 });
  console.log('  patch ' + hooksPath + ' (sessionStart += slack)');
} else {
  console.log('  keep  ' + hooksPath + ' (sessionStart already registered)');
}
NODE
  fi
fi

if [[ "$PRINT_NEXT" -eq 1 ]]; then
  cat <<EOF

Next steps (never commit resolved secrets):

  1. Shared Slack (same values for every engineer)
     - Ask an admin for 1Password access to the shared Engineering vault item
       "Agent Slack Bot" (or your org's equivalent).
     - Prefer:
         bash team-setup/scripts/materialize-workspace-secrets-from-1password.sh \\
           --workspace ${WORKSPACE} --slack-only
     - Or copy ${TARGET_DIR}/slack.env.example → slack.env and paste values
       (chmod 600). Never send tokens over Slack/email.

  2. Private GitHub App (your bot name is fine)
     - Create/install a GitHub App (or use the org shared Addi app).
     - Write the PEM to ${TARGET_DIR}/github-app.pem (chmod 600).
     - Fill ${TARGET_DIR}/github-app.env (from .example or op inject).
     - Verify:
         eval "\$(bash ${TARGET_DIR}/github-app-activate.sh)"
         gh api graphql -f query='query { viewer { login } }' --jq .data.viewer.login

  3. Shell + Cursor
     - Source slack.env from ~/.zshrc, or eval slack-activate.sh when needed.
     - New Cursor chats pick up Slack via sessionStart when the hook is registered
       (--register-cursor-hook).

  4. Verify without printing secrets:
         bash team-setup/scripts/verify-workspace-secrets.sh --workspace ${WORKSPACE}

Full walkthrough: team-setup/docs/workspace-agent-secrets.md
EOF
fi
