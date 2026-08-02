#!/usr/bin/env bash
# Watch one or more PRs for a human APPROVED review, then emit an agent wake.
#
# Usage:
#   bash .cursor/skills/pr-approve-watch/scripts/watch-pr-approve.sh \
#     --interval 30 \
#     [--activate ~/.config/rosetta/github-app-activate.sh] \
#     Rosetta-Foundation/rosetta_docs#31 \
#     Rosetta-Foundation/rosetta_dev-scripts#55
#
# Sentinel (stdout): AGENT_LOOP_WAKE_pr_approve <json>
# Pair with Cursor agent loop notify_on_output on ^AGENT_LOOP_WAKE_pr_approve.
set -euo pipefail

INTERVAL=30
ACTIVATE=""
TARGETS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --interval)
      INTERVAL="${2:?}"
      shift 2
      ;;
    --interval=*)
      INTERVAL="${1#*=}"
      shift
      ;;
    --activate)
      ACTIVATE="${2:?}"
      shift 2
      ;;
    --activate=*)
      ACTIVATE="${1#*=}"
      shift
      ;;
    -h|--help)
      sed -n '2,18p' "$0"
      exit 0
      ;;
    *)
      TARGETS+=("$1")
      shift
      ;;
  esac
done

if [[ ${#TARGETS[@]} -eq 0 ]]; then
  echo "usage: $0 [--interval SECONDS] [--activate PATH] owner/repo#N [...]" >&2
  exit 2
fi

resolve_activate() {
  if [[ -n "$ACTIVATE" ]]; then
    printf '%s' "$ACTIVATE"
    return
  fi
  if [[ -n "${ROSETTA_GH_ACTIVATE:-}" ]]; then
    printf '%s' "$ROSETTA_GH_ACTIVATE"
    return
  fi
  # Prefer the activate script that matches the cwd workspace name.
  local cwd
  cwd=$(pwd -P 2>/dev/null || pwd)
  case "$cwd" in
    */comita|*/comita/*)
      if [[ -x "$HOME/.config/comita/github-app-activate.sh" ]]; then
        printf '%s' "$HOME/.config/comita/github-app-activate.sh"
        return
      fi
      ;;
  esac
  if [[ -x "$HOME/.config/rosetta/github-app-activate.sh" ]]; then
    printf '%s' "$HOME/.config/rosetta/github-app-activate.sh"
    return
  fi
  if [[ -x "$HOME/.config/comita/github-app-activate.sh" ]]; then
    printf '%s' "$HOME/.config/comita/github-app-activate.sh"
    return
  fi
  printf ''
}

ACTIVATE_SCRIPT=$(resolve_activate)

activate() {
  if [[ -z "$ACTIVATE_SCRIPT" ]]; then
    # Fall back to ambient gh auth (human operator).
    return 0
  fi
  if [[ ! -f "$ACTIVATE_SCRIPT" ]]; then
    echo "watch-pr-approve: activate script not found: $ACTIVATE_SCRIPT" >&2
    exit 1
  fi
  # shellcheck disable=SC1090
  eval "$(bash "$ACTIVATE_SCRIPT")"
}

is_approved() {
  local repo="$1" num="$2"
  local decision count
  decision=$(gh pr view "$num" -R "$repo" --json reviewDecision --jq '.reviewDecision // empty' 2>/dev/null || true)
  if [[ "$decision" == "APPROVED" ]]; then
    echo 1
    return
  fi
  # Fallback when branch protection does not set reviewDecision: any non-bot APPROVED review.
  count=$(gh api "repos/${repo}/pulls/${num}/reviews" --paginate \
    --jq '[.[] | select(.state=="APPROVED" and (.user.type // "User") != "Bot")] | length' \
    2>/dev/null || echo 0)
  if [[ "${count:-0}" -gt 0 ]]; then
    echo 1
  else
    echo 0
  fi
}

FIRED=()
for _ in "${TARGETS[@]}"; do
  FIRED+=(0)
done

activate
REMAINING=${#TARGETS[@]}
TICK=0
echo "watch-pr-approve: watching ${TARGETS[*]} every ${INTERVAL}s (activate=${ACTIVATE_SCRIPT:-ambient-gh})" >&2

while [[ "$REMAINING" -gt 0 ]]; do
  TICK=$((TICK + 1))
  # Installation tokens expire ~1h; refresh every ~45m at 30s interval.
  if (( TICK % 90 == 0 )); then
    activate
  fi

  i=0
  while [[ $i -lt ${#TARGETS[@]} ]]; do
    if [[ "${FIRED[$i]}" -eq 0 ]]; then
      t="${TARGETS[$i]}"
      repo="${t%%#*}"
      num="${t##*#}"
      if [[ "$repo" == "$t" || -z "$num" ]]; then
        echo "watch-pr-approve: bad target '$t' (want owner/repo#N)" >&2
        FIRED[$i]=1
        REMAINING=$((REMAINING - 1))
        i=$((i + 1))
        continue
      fi
      ok=$(is_approved "$repo" "$num")
      if [[ "${ok:-0}" -gt 0 ]]; then
        FIRED[$i]=1
        REMAINING=$((REMAINING - 1))
        payload=$(TARGET="$t" REPO="$repo" NUM="$num" REMAINING="$REMAINING" python3 - <<'PY'
import json, os
t = os.environ["TARGET"]
repo = os.environ["REPO"]
num = int(os.environ["NUM"])
remaining = int(os.environ["REMAINING"])
print(json.dumps({
  "prompt": (
    f"PR approve proceed signal fired for {t}. "
    "Activate the workspace GitHub App (Addi), verify APPROVED + green checks, "
    "then triage all PR review comments and unresolved reviewThreads "
    "(fix / reply with commit SHA / resolveReviewThread; do not merge with "
    "unaddressed actionable comments). Re-check CI if you pushed fixes, then "
    "merge, pull the repo default branch locally, and report. "
    "Keep watching any remaining unapproved PRs from this same watch set."
  ),
  "repo": repo,
  "number": num,
  "target": t,
  "remaining": remaining,
}))
PY
)
        printf 'AGENT_LOOP_WAKE_pr_approve %s\n' "$payload"
        echo "watch-pr-approve: APPROVED → $t (remaining=$REMAINING)" >&2
      fi
    fi
    i=$((i + 1))
  done

  if [[ "$REMAINING" -gt 0 ]]; then
    sleep "$INTERVAL"
  fi
done

echo "watch-pr-approve: all targets approved; exiting" >&2
