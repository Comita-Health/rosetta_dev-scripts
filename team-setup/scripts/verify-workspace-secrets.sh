#!/usr/bin/env bash
# Verify workspace agent secrets layout without printing secret values.
#
# Usage:
#   bash team-setup/scripts/verify-workspace-secrets.sh --workspace comita
#   bash … --workspace comita --online   # hit Slack auth.test + gh viewer

set -euo pipefail

WORKSPACE=""
CONFIG_HOME="${HOME}/.config"
ONLINE=0
STRICT=0

usage() {
  sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//'
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
    --online)
      ONLINE=1
      shift
      ;;
    --strict)
      STRICT=1
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

TARGET_DIR="${CONFIG_HOME}/${WORKSPACE}"
failures=0
warnings=0

pass() { echo "  ok   $*"; }
warn() {
  echo "  warn $*"
  warnings=$((warnings + 1))
}
fail() {
  echo "  FAIL $*"
  failures=$((failures + 1))
}

mode_of() {
  # portable-ish: prefer stat -f (BSD) then stat -c (GNU)
  local f="$1"
  if stat -f '%Lp' "$f" >/dev/null 2>&1; then
    stat -f '%Lp' "$f"
  else
    stat -c '%a' "$f"
  fi
}

echo "Verifying ${TARGET_DIR}"

if [[ ! -d "$TARGET_DIR" ]]; then
  fail "directory missing — run scaffold-workspace-secrets.sh"
  echo "Result: FAIL"
  exit 1
fi

for script in github-app-activate.sh github-app-token.sh slack-activate.sh; do
  path="${TARGET_DIR}/${script}"
  if [[ -f "$path" ]]; then
    pass "$script present"
  else
    fail "$script missing"
  fi
done

check_secret_file() {
  local path="$1"
  local label="$2"
  local required_keys_csv="${3:-}"
  if [[ ! -f "$path" ]]; then
    if [[ "$STRICT" -eq 1 ]]; then
      fail "$label missing ($path)"
    else
      warn "$label missing ($path)"
    fi
    return 0
  fi
  local mode
  mode="$(mode_of "$path")"
  if [[ "$mode" != "600" && "$mode" != "400" ]]; then
    fail "$label mode is ${mode} (expected 600 or 400)"
  else
    pass "$label mode ${mode}"
  fi
  if [[ -n "$required_keys_csv" ]]; then
    # Isolate sourced vars so secret values do not linger in this shell.
    local report
    report="$(
      KEYS="$required_keys_csv" PATH_ENV="$path" bash -c '
        set -euo pipefail
        set -a
        # shellcheck disable=SC1090
        source "$PATH_ENV"
        set +a
        IFS="," read -r -a keys <<<"$KEYS"
        for key in "${keys[@]}"; do
          val="${!key:-}"
          if [[ -z "$val" ]]; then
            echo "EMPTY:$key"
          else
            echo "OK:$key:${#val}"
          fi
        done
      '
    )"
    while IFS= read -r line; do
      [[ -z "$line" ]] && continue
      case "$line" in
        EMPTY:*)
          fail "$label: ${line#EMPTY:} empty"
          ;;
        OK:*)
          rest="${line#OK:}"
          key="${rest%%:*}"
          len="${rest#*:}"
          pass "$label: ${key} set (len=${len})"
          ;;
      esac
    done <<<"$report"
  fi
}

check_secret_file "${TARGET_DIR}/slack.env" "slack.env" \
  "SLACK_BOT_TOKEN,SLACK_CHANNEL_ID,SLACK_SIGNING_SECRET"
check_secret_file "${TARGET_DIR}/github-app.env" "github-app.env" \
  "GITHUB_APP_ID,GITHUB_APP_INSTALLATION_ID,GITHUB_APP_PRIVATE_KEY_PATH,GITHUB_APP_SLUG"

pem="${TARGET_DIR}/github-app.pem"
if [[ -f "$pem" ]]; then
  mode="$(mode_of "$pem")"
  if [[ "$mode" != "600" && "$mode" != "400" ]]; then
    fail "github-app.pem mode is ${mode}"
  else
    pass "github-app.pem mode ${mode}"
  fi
  if head -n 1 "$pem" | grep -q 'BEGIN.*PRIVATE KEY'; then
    pass "github-app.pem looks like a PEM header"
  else
    fail "github-app.pem missing BEGIN PRIVATE KEY header"
  fi
else
  warn "github-app.pem missing"
fi

if [[ "$ONLINE" -eq 1 ]]; then
  if [[ -f "${TARGET_DIR}/slack.env" ]]; then
    # shellcheck disable=SC1090
    set -a
    source "${TARGET_DIR}/slack.env"
    set +a
    if [[ -n "${SLACK_BOT_TOKEN:-}" ]] && command -v curl >/dev/null 2>&1; then
      ok="$(curl -sS -H "Authorization: Bearer ${SLACK_BOT_TOKEN}" \
        https://slack.com/api/auth.test | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{try{const j=JSON.parse(d);process.stdout.write(j.ok?"true":"false")}catch{process.stdout.write("false")}}')"
      if [[ "$ok" == "true" ]]; then
        pass "Slack auth.test ok"
      else
        fail "Slack auth.test failed"
      fi
    else
      warn "skip Slack online check (no token or curl)"
    fi
  fi
  if [[ -x "${TARGET_DIR}/github-app-activate.sh" ]]; then
    if eval "$(bash "${TARGET_DIR}/github-app-activate.sh")" 2>/dev/null; then
      login="$(gh api graphql -f query='query { viewer { login } }' --jq '.data.viewer.login' 2>/dev/null || true)"
      if [[ -n "$login" ]]; then
        pass "GitHub App viewer login present (len=${#login})"
      else
        fail "GitHub App activate did not yield a viewer login"
      fi
    else
      fail "github-app-activate.sh failed"
    fi
  fi
fi

echo ""
if [[ "$failures" -gt 0 ]]; then
  echo "Result: FAIL (${failures} failure(s), ${warnings} warning(s))"
  exit 1
fi
echo "Result: OK (${warnings} warning(s))"
exit 0
