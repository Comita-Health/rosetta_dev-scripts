#!/usr/bin/env bash
# Watch one or more PRs for human review signals, then emit an agent wake.
#
# Signals:
#   APPROVED           → wake once, then stop watching that target (merge path)
#   CHANGES_REQUESTED  → wake once per new non-bot review id; keep watching
#                        until Approve (or the PR closes)
#
# Usage:
#   bash .cursor/skills/pr-approve-watch/scripts/watch-pr-approve.sh \
#     --interval 30 \
#     [--activate ~/.config/rosetta/github-app-activate.sh] \
#     Rosetta-Foundation/rosetta_docs#31 \
#     Rosetta-Foundation/rosetta_dev-scripts#1
#
# Sentinel (stdout): AGENT_LOOP_WAKE_pr_approve <json>
# JSON includes "signal": "approved" | "changes_requested"
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
      sed -n '2,20p' "$0"
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

# Durable wake inbox, when this checkout has one (workspace root scripts/).
for candidate in \
  "$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../../scripts" 2>/dev/null && pwd)/wake-inbox.sh" \
  "$HOME/.rosetta/scripts/wake-inbox.sh"; do
  if [[ -f "$candidate" ]]; then
    # shellcheck disable=SC1090
    source "$candidate"
    break
  fi
done

resolve_activate() {
  if [[ -n "$ACTIVATE" ]]; then
    printf '%s' "$ACTIVATE"
    return
  fi
  if [[ -n "${ROSETTA_GH_ACTIVATE:-}" ]]; then
    printf '%s' "$ROSETTA_GH_ACTIVATE"
    return
  fi
  if [[ -x "$HOME/.config/rosetta/github-app-activate.sh" ]]; then
    printf '%s' "$HOME/.config/rosetta/github-app-activate.sh"
    return
  fi
  local candidate
  for candidate in "$HOME"/.config/*/github-app-activate.sh; do
    if [[ -x "$candidate" ]]; then
      printf '%s' "$candidate"
      return
    fi
  done
  printf ''
}

ACTIVATE_SCRIPT=$(resolve_activate)

LAST_ACTIVATE_AT=0
# App installation tokens expire after 60 minutes; refresh well inside that.
ACTIVATE_TTL=1800

activate() {
  if [[ -z "$ACTIVATE_SCRIPT" ]]; then
    return 0
  fi
  if [[ ! -f "$ACTIVATE_SCRIPT" ]]; then
    echo "watch-pr-approve: activate script not found: $ACTIVATE_SCRIPT" >&2
    exit 1
  fi
  # shellcheck disable=SC1090
  eval "$(bash "$ACTIVATE_SCRIPT")"
  LAST_ACTIVATE_AT=$SECONDS

  # Verify rather than assume: a silently-expired token is what turns this
  # watcher into a process that runs forever and never fires.
  if ! gh api rate_limit >/dev/null 2>&1; then
    echo "watch-pr-approve: token failed verification after activate" >&2
    return 1
  fi
}

# Refresh on elapsed wall-clock, not tick count — tick count drifts with the
# interval and with how long each poll takes, so a slow tick could let the
# token expire between refreshes.
maybe_reactivate() {
  if [[ -z "$ACTIVATE_SCRIPT" ]]; then
    return 0
  fi
  if (( SECONDS - LAST_ACTIVATE_AT >= ACTIVATE_TTL )); then
    activate || true
  fi
}

# Prints: approved | changes_requested | none
classify_review_signal() {
  local repo="$1" num="$2"
  local decision
  decision=$(gh pr view "$num" -R "$repo" --json reviewDecision --jq '.reviewDecision // empty' 2>/dev/null || true)
  if [[ "$decision" == "APPROVED" ]]; then
    echo approved
    return
  fi
  if [[ "$decision" == "CHANGES_REQUESTED" ]]; then
    echo changes_requested
    return
  fi

  # Fallback when branch protection does not set reviewDecision.
  local approved_count changes_count
  approved_count=$(count_reviews "$repo" "$num" APPROVED)
  if [[ "$approved_count" -gt 0 ]]; then
    echo approved
    return
  fi
  changes_count=$(count_reviews "$repo" "$num" CHANGES_REQUESTED)
  if [[ "$changes_count" -gt 0 ]]; then
    echo changes_requested
    return
  fi
  echo none
}

# Non-bot reviews in the given state, or 0 when the call fails.
#
# `gh` writes its API error body to stdout, so on a 401 the raw JSON would be
# captured as the "count" and poison the `-gt` comparison below — under
# `set -e` that aborts the tick, and the watcher then spins forever without
# ever firing. Discard stdout on failure and insist on digits.
count_reviews() {
  local repo="$1" num="$2" state="$3" out
  if ! out=$(gh api "repos/${repo}/pulls/${num}/reviews" --paginate \
    --jq "[.[] | select(.state==\"${state}\" and (.user.type // \"User\") != \"Bot\")] | length" \
    2>/dev/null); then
    echo 0
    return
  fi
  out=$(printf '%s' "$out" | tr -d '[:space:]')
  if [[ "$out" =~ ^[0-9]+$ ]]; then
    echo "$out"
  else
    echo 0
  fi
}

# Latest non-bot CHANGES_REQUESTED review id (empty if none).
latest_changes_requested_review_id() {
  local repo="$1" num="$2"
  gh api "repos/${repo}/pulls/${num}/reviews" --paginate \
    --jq '[.[] | select(.state=="CHANGES_REQUESTED" and (.user.type // "User") != "Bot")] | sort_by(.submitted_at // "") | last | .id // empty' \
    2>/dev/null || true
}

emit_wake() {
  local t="$1" repo="$2" num="$3" remaining="$4" signal="$5"
  local payload
  payload=$(
    TARGET="$t" REPO="$repo" NUM="$num" REMAINING="$remaining" SIGNAL="$signal" python3 - <<'PY'
import json, os
t = os.environ["TARGET"]
repo = os.environ["REPO"]
num = int(os.environ["NUM"])
remaining = int(os.environ["REMAINING"])
signal = os.environ["SIGNAL"]
if signal == "changes_requested":
    prompt = (
        f"PR changes-requested signal fired for {t}. "
        "Activate the workspace GitHub App (Addi). Do NOT merge. "
        "Read the human Request changes review body and all inline / unresolved "
        "reviewThreads. Fix actionable feedback on the PR branch, commit, push; "
        "reply on each thread with the fix commit SHA; resolveReviewThread when "
        "addressed. Re-check CI after pushes. Leave the PR open for the human to "
        "re-review (Approve when satisfied). Keep watching this PR for Approve "
        "or another Request changes. Keep watching any remaining targets."
    )
else:
    prompt = (
        f"PR approve proceed signal fired for {t}. "
        "Activate the workspace GitHub App (Addi), verify APPROVED + green checks, "
        "then triage all PR review comments and unresolved reviewThreads "
        "(fix / reply with commit SHA / resolveReviewThread; do not merge with "
        "unaddressed actionable comments). Re-check CI if you pushed fixes, then "
        "merge, pull the repo default branch locally, and report. "
        "Keep watching any remaining unapproved PRs from this same watch set."
    )
print(json.dumps({
    "prompt": prompt,
    "signal": signal,
    "repo": repo,
    "number": num,
    "target": t,
    "remaining": remaining,
}))
PY
  )
  # Durable first: a wake written to the inbox survives this terminal dying,
  # and wake_emit prints the stdout sentinel too for any live listener.
  if declare -F wake_emit >/dev/null 2>&1; then
    local prompt
    prompt=$(printf '%s' "$payload" | python3 -c 'import json,sys; print(json.load(sys.stdin)["prompt"])')
    wake_emit pr_approve "${t}-${signal}" "$prompt" "$payload"
  else
    printf 'AGENT_LOOP_WAKE_pr_approve %s\n' "$payload"
  fi
  echo "watch-pr-approve: ${signal} → $t (remaining=$remaining)" >&2
}

# Per-target: 0=watching, 1=done (approved or closed)
DONE=()
# Last CHANGES_REQUESTED review id we already woke on (per target index)
LAST_CR_ID=()
for _ in "${TARGETS[@]}"; do
  DONE+=(0)
  LAST_CR_ID+=("")
done

# PID registry: re-arming the same target set must not stack a second watcher
# on top of a live one (that is how eleven of these accumulated).
REGISTRY_DIR="${ROSETTA_WAKE_DIR:-$HOME/.rosetta/wake}/watchers"
mkdir -p "$REGISTRY_DIR"
REGISTRY_KEY=$(printf 'pr-approve-%s' "${TARGETS[*]}" | tr -c 'A-Za-z0-9._-' '-' | cut -c1-96)
REGISTRY_FILE="$REGISTRY_DIR/${REGISTRY_KEY}.pid"

if [[ -f "$REGISTRY_FILE" ]]; then
  existing=$(cat "$REGISTRY_FILE" 2>/dev/null || true)
  if [[ -n "$existing" ]] && kill -0 "$existing" 2>/dev/null; then
    echo "watch-pr-approve: already watching ${TARGETS[*]} as PID $existing — exiting" >&2
    exit 0
  fi
fi
printf '%s' "$$" >"$REGISTRY_FILE"
trap 'rm -f "$REGISTRY_FILE"' EXIT

activate || echo "watch-pr-approve: initial activate failed; continuing with ambient gh" >&2
REMAINING=${#TARGETS[@]}
TICK=0
echo "watch-pr-approve: watching ${TARGETS[*]} every ${INTERVAL}s for Approve or Request changes (activate=${ACTIVATE_SCRIPT:-ambient-gh}, pid=$$)" >&2

while [[ "$REMAINING" -gt 0 ]]; do
  TICK=$((TICK + 1))
  maybe_reactivate

  i=0
  while [[ $i -lt ${#TARGETS[@]} ]]; do
    if [[ "${DONE[$i]}" -eq 0 ]]; then
      t="${TARGETS[$i]}"
      repo="${t%%#*}"
      num="${t##*#}"
      if [[ "$repo" == "$t" || -z "$num" ]]; then
        echo "watch-pr-approve: bad target '$t' (want owner/repo#N)" >&2
        DONE[$i]=1
        REMAINING=$((REMAINING - 1))
        i=$((i + 1))
        continue
      fi

      state=$(gh pr view "$num" -R "$repo" --json state --jq '.state // empty' 2>/dev/null || true)
      if [[ "$state" == "MERGED" || "$state" == "CLOSED" ]]; then
        DONE[$i]=1
        REMAINING=$((REMAINING - 1))
        echo "watch-pr-approve: $t is $state — stop watching (remaining=$REMAINING)" >&2
        i=$((i + 1))
        continue
      fi

      signal=$(classify_review_signal "$repo" "$num")
      if [[ "$signal" == "approved" ]]; then
        DONE[$i]=1
        REMAINING=$((REMAINING - 1))
        emit_wake "$t" "$repo" "$num" "$REMAINING" approved
      elif [[ "$signal" == "changes_requested" ]]; then
        cr_id=$(latest_changes_requested_review_id "$repo" "$num")
        if [[ -n "$cr_id" && "$cr_id" != "${LAST_CR_ID[$i]}" ]]; then
          LAST_CR_ID[$i]="$cr_id"
          # Keep watching until Approve; remaining unchanged.
          emit_wake "$t" "$repo" "$num" "$REMAINING" changes_requested
        fi
      fi
    fi
    i=$((i + 1))
  done

  if [[ "$REMAINING" -gt 0 ]]; then
    sleep "$INTERVAL"
  fi
done

echo "watch-pr-approve: all targets resolved; exiting" >&2
