#!/usr/bin/env bash
# Watch one or more GitHub issues for actionable events, then emit an agent wake.
# Default goal: drive each issue to resolution (Done-when met → close).
#
# Usage:
#   bash .cursor/skills/issue-resolve-watch/scripts/watch-issue-resolve.sh \
#     --interval 30 \
#     [--activate ~/.config/rosetta/github-app-activate.sh] \
#     [--kickoff] \
#     Rosetta-Foundation/rosetta_dev-scripts#1
#
# Sentinel (stdout): AGENT_LOOP_WAKE_issue_resolve <json>
# Pair with Cursor agent loop notify_on_output on ^AGENT_LOOP_WAKE_issue_resolve.
#
# Wake reasons: kickoff | human_comment | linked_pr | closed
set -euo pipefail

INTERVAL=30
ACTIVATE=""
KICKOFF=0
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
    --kickoff)
      KICKOFF=1
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
  echo "usage: $0 [--interval SECONDS] [--activate PATH] [--kickoff] owner/repo#N [...]" >&2
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

activate() {
  if [[ -z "$ACTIVATE_SCRIPT" ]]; then
    return 0
  fi
  if [[ ! -f "$ACTIVATE_SCRIPT" ]]; then
    echo "watch-issue-resolve: activate script not found: $ACTIVATE_SCRIPT" >&2
    exit 1
  fi
  # shellcheck disable=SC1090
  eval "$(bash "$ACTIVATE_SCRIPT")"
}

emit_wake() {
  local target="$1" repo="$2" num="$3" reason="$4" remaining="$5"
  local payload
  payload=$(
    TARGET="$target" REPO="$repo" NUM="$num" REASON="$reason" REMAINING="$remaining" python3 - <<'PY'
import json, os
print(json.dumps({
  "prompt": (
    f"Issue resolve wake ({os.environ['REASON']}) for {os.environ['TARGET']}. "
    "Activate the workspace GitHub App (Addi). Drive the issue toward "
    "resolution: read title/body/Done-when, triage new comments, implement "
    "or open/land PRs as needed, update checkboxes, and close when Done-when "
    "is met. Do not leave a watched issue idle without a next step or a clear "
    "human blocker noted on the issue. Chat notify is best-effort — drain "
    "this wake from the watcher terminal even if the chat stayed quiet. "
    "Keep watching remaining open targets."
  ),
  "repo": os.environ["REPO"],
  "number": int(os.environ["NUM"]),
  "target": os.environ["TARGET"],
  "reason": os.environ["REASON"],
  "remaining": int(os.environ["REMAINING"]),
}))
PY
  )
  printf 'AGENT_LOOP_WAKE_issue_resolve %s\n' "$payload"
  echo "watch-issue-resolve: $reason → $target (remaining=$remaining)" >&2
  echo "watch-issue-resolve: NOTE chat notify is best-effort; agent must drain AGENT_LOOP_WAKE_issue_resolve from this terminal if the chat stays quiet." >&2
}

STATE_DIR=$(mktemp -d "${TMPDIR:-/tmp}/issue-resolve-watch.XXXXXX")
cleanup() { rm -rf "$STATE_DIR"; }
trap cleanup EXIT

write_state() {
  local file="$1"
  shift
  printf '%s\n' "$1" >"$file"
}

read_field() {
  local file="$1" field="$2"
  python3 -c "import json; print(json.load(open('$file')).get('$field', 0))"
}

init_target_state() {
  local file="$1" repo="$2" num="$3"
  local state last_comment last_event
  state=$(gh issue view "$num" -R "$repo" --json state --jq '.state' 2>/dev/null || echo OPEN)
  last_comment=$(
    gh api "repos/${repo}/issues/${num}/comments" --paginate \
      --jq '[.[] | select((.user.type // "User") != "Bot") | .id] | max // 0' \
      2>/dev/null || echo 0
  )
  last_event=$(
    gh api "repos/${repo}/issues/${num}/timeline" --paginate \
      --jq '[.[] | .id // 0] | max // 0' 2>/dev/null || echo 0
  )
  write_state "$file" "$(python3 - <<PY
import json
print(json.dumps({
  "last_comment": int("$last_comment" or 0),
  "last_event": int("$last_event" or 0),
  "state": "$state",
  "done": 1 if "$state" == "CLOSED" else 0,
}))
PY
)"
}

# Prints reason to stdout if a wake should fire; updates state file.
poll_target() {
  local file="$1" repo="$2" num="$3"
  python3 - "$file" "$repo" "$num" <<'PY'
import json, subprocess, sys

state_path, repo, num = sys.argv[1], sys.argv[2], sys.argv[3]
prev = json.load(open(state_path))

def gh_json(args):
    out = subprocess.check_output(["gh", *args], text=True, stderr=subprocess.DEVNULL)
    return json.loads(out)

try:
    issue = gh_json(["issue", "view", num, "-R", repo, "--json", "state"])
    cur_state = issue.get("state") or "OPEN"
except Exception:
    cur_state = "UNKNOWN"

try:
    comments = gh_json(["api", f"repos/{repo}/issues/{num}/comments", "--paginate"])
except Exception:
    comments = []
human_ids = [
    int(c["id"])
    for c in comments
    if (c.get("user") or {}).get("type", "User") != "Bot"
]
cur_comment = max(human_ids) if human_ids else 0

try:
    events = gh_json(["api", f"repos/{repo}/issues/{num}/timeline", "--paginate"])
except Exception:
    events = []
cur_event = max((int(e.get("id") or 0) for e in events), default=0)

last_event = int(prev.get("last_event") or 0)
linked_pr = False
interesting = {"cross-referenced", "connected", "referenced"}
for e in events:
    eid = int(e.get("id") or 0)
    if eid <= last_event:
        continue
    et = e.get("event") or ""
    if et not in interesting:
        continue
    src = e.get("source") or {}
    issue_src = src.get("issue") or {}
    if issue_src.get("pull_request") is not None or et == "cross-referenced":
        linked_pr = True
        break

reason = ""
prev_state = prev.get("state") or "OPEN"
prev_comment = int(prev.get("last_comment") or 0)
if cur_state == "CLOSED" and prev_state != "CLOSED":
    reason = "closed"
elif cur_comment > prev_comment:
    reason = "human_comment"
elif linked_pr:
    reason = "linked_pr"

done = 1 if reason == "closed" or cur_state == "CLOSED" else int(prev.get("done") or 0)
json.dump(
    {
        "last_comment": cur_comment,
        "last_event": cur_event,
        "state": cur_state,
        "done": done,
    },
    open(state_path, "w"),
)
if reason:
    print(reason)
PY
}

activate
REMAINING=${#TARGETS[@]}
TICK=0
echo "watch-issue-resolve: watching ${TARGETS[*]} every ${INTERVAL}s kickoff=$KICKOFF (activate=${ACTIVATE_SCRIPT:-ambient-gh})" >&2

declare -a REPOS NUMS
i=0
while [[ $i -lt ${#TARGETS[@]} ]]; do
  t="${TARGETS[$i]}"
  repo="${t%%#*}"
  num="${t##*#}"
  if [[ "$repo" == "$t" || -z "$num" ]]; then
    echo "watch-issue-resolve: bad target '$t' (want owner/repo#N)" >&2
    exit 2
  fi
  REPOS+=("$repo")
  NUMS+=("$num")
  init_target_state "$STATE_DIR/$i" "$repo" "$num"
  if [[ "$(read_field "$STATE_DIR/$i" done)" -eq 1 ]]; then
    REMAINING=$((REMAINING - 1))
  fi
  i=$((i + 1))
done

if [[ "$KICKOFF" -eq 1 ]]; then
  i=0
  while [[ $i -lt ${#TARGETS[@]} ]]; do
    if [[ "$(read_field "$STATE_DIR/$i" done)" -eq 0 ]]; then
      emit_wake "${TARGETS[$i]}" "${REPOS[$i]}" "${NUMS[$i]}" "kickoff" "$REMAINING"
    fi
    i=$((i + 1))
  done
fi

while [[ "$REMAINING" -gt 0 ]]; do
  TICK=$((TICK + 1))
  if (( TICK % 90 == 0 )); then
    activate
  fi

  i=0
  while [[ $i -lt ${#TARGETS[@]} ]]; do
    if [[ "$(read_field "$STATE_DIR/$i" done)" -eq 0 ]]; then
      reason=$(poll_target "$STATE_DIR/$i" "${REPOS[$i]}" "${NUMS[$i]}" || true)
      if [[ -n "${reason:-}" ]]; then
        if [[ "$reason" == "closed" ]]; then
          REMAINING=$((REMAINING - 1))
        fi
        emit_wake "${TARGETS[$i]}" "${REPOS[$i]}" "${NUMS[$i]}" "$reason" "$REMAINING"
      fi
    fi
    i=$((i + 1))
  done

  if [[ "$REMAINING" -gt 0 ]]; then
    sleep "$INTERVAL"
  fi
done

echo "watch-issue-resolve: all targets resolved/closed; exiting" >&2
