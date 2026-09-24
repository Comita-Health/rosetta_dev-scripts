#!/usr/bin/env bash
# Watch open PRs for GitHub check failures, then emit an agent wake.
#
# Usage:
#   bash .cursor/skills/pr-checks-watch/scripts/watch-pr-checks.sh \
#     --interval 30 \
#     [--activate ~/.config/comita/github-app-activate.sh] \
#     [--kickoff] \
#     Owner/repo#123
#
# Sentinel (stdout): AGENT_LOOP_WAKE_pr_checks <json>
# Pair with Cursor agent loop notify_on_output on ^AGENT_LOOP_WAKE_pr_checks.
#
# Wake reasons: kickoff | checks_failed | checks_success | pr_merged | pr_closed
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
  if [[ -x "$HOME/.config/comita/github-app-activate.sh" ]]; then
    printf '%s' "$HOME/.config/comita/github-app-activate.sh"
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
    echo "watch-pr-checks: activate script not found: $ACTIVATE_SCRIPT" >&2
    exit 1
  fi
  # shellcheck disable=SC1090
  eval "$(bash "$ACTIVATE_SCRIPT")"
}

emit_wake() {
  local target="$1" repo="$2" num="$3" reason="$4" remaining="$5"
  local sha="${6:-}" failed="${7:-}"
  local payload
  payload=$(
    TARGET="$target" REPO="$repo" NUM="$num" REASON="$reason" \
    REMAINING="$remaining" SHA="$sha" FAILED="$failed" python3 - <<'PY'
import json, os
sha = os.environ.get("SHA") or ""
failed = [n for n in os.environ.get("FAILED", "").split("|") if n]
short = sha[:7] if sha else "unknown"
prompt = (
    f"PR-checks wake ({os.environ['REASON']}) for {os.environ['TARGET']} "
    f"at {short}. Activate the workspace GitHub App (Addi). "
)
if os.environ["REASON"] == "checks_failed":
    prompt += (
        "A required check failed. Read gh run view --log-failed / "
        "annotations, fix in the drop worktree, commit -s, push. "
        "Do not merge. Keep watching remaining open targets."
    )
elif os.environ["REASON"] == "checks_success":
    prompt += (
        "Checks are green for this SHA. Do not merge — Approve remains "
        "the proceed signal (pr-approve-watch / GHA). Brief note only."
    )
elif os.environ["REASON"] in ("pr_merged", "pr_closed"):
    prompt += "This target is done. Drop it from the watch set."
else:
    prompt += (
        "Inspect the current check rollup. If already red, remediate "
        "as checks_failed. If pending, wait. Do not merge on green."
    )
print(json.dumps({
    "prompt": prompt,
    "repo": os.environ["REPO"],
    "number": int(os.environ["NUM"]),
    "target": os.environ["TARGET"],
    "reason": os.environ["REASON"],
    "remaining": int(os.environ["REMAINING"]),
    "sha": sha,
    "failedChecks": failed,
}))
PY
  )
  printf 'AGENT_LOOP_WAKE_pr_checks %s\n' "$payload"
  echo "watch-pr-checks: $reason → $target (remaining=$remaining sha=${sha:-none})" >&2
  echo "watch-pr-checks: NOTE chat notify is best-effort; drain AGENT_LOOP_WAKE_pr_checks from this terminal if the chat stays quiet." >&2
}

STATE_DIR=$(mktemp -d "${TMPDIR:-/tmp}/pr-checks-watch.XXXXXX")
cleanup() { rm -rf "$STATE_DIR"; }
trap cleanup EXIT

write_state() {
  printf '%s\n' "$1" >"$2"
}

read_field() {
  local file="$1" field="$2"
  python3 -c "import json; print(json.load(open('$file')).get('$field', ''))"
}

NON_FAILING='success,neutral,skipped,pass'

poll_target() {
  local file="$1" repo="$2" num="$3"
  python3 - "$file" "$repo" "$num" "$NON_FAILING" <<'PY'
import json, subprocess, sys

state_path, repo, num, non_failing_csv = sys.argv[1:5]
non_failing = {s.strip().lower() for s in non_failing_csv.split(",") if s.strip()}
prev = json.load(open(state_path))

def gh_json(args):
    out = subprocess.check_output(["gh", *args], text=True, stderr=subprocess.DEVNULL)
    return json.loads(out)

try:
    pr = gh_json([
        "pr", "view", num, "-R", repo,
        "--json", "state,headRefOid,statusCheckRollup",
    ])
except Exception:
    print("")
    raise SystemExit(0)

cur_state = (pr.get("state") or "OPEN").upper()
sha = pr.get("headRefOid") or ""
checks = pr.get("statusCheckRollup") or []

if cur_state == "MERGED":
    reason = "pr_merged" if prev.get("state") != "MERGED" else ""
    done = 1
elif cur_state == "CLOSED":
    reason = "pr_closed" if prev.get("state") != "CLOSED" else ""
    done = 1
else:
    done = 0
    pending = False
    failed = []
    for check in checks:
        status = (check.get("status") or "").upper()
        conclusion = (check.get("conclusion") or check.get("state") or "").lower()
        name = check.get("name") or check.get("context") or "unknown"
        if status and status not in ("COMPLETED", "SUCCESS", "FAILURE"):
            if status in ("IN_PROGRESS", "QUEUED", "PENDING", "WAITING", "REQUESTED"):
                pending = True
                continue
        if not conclusion:
            if status in ("IN_PROGRESS", "QUEUED", "PENDING", "WAITING", "REQUESTED", ""):
                pending = True
                continue
        if conclusion in non_failing:
            continue
        if conclusion in ("failure", "fail", "timed_out", "action_required",
                          "cancelled", "startup_failure", "stale", "error"):
            failed.append(name)
        elif conclusion and conclusion not in non_failing:
            failed.append(name)

    if pending or (not checks and cur_state == "OPEN"):
        reason = ""
    elif failed:
        key = f"failed:{sha}"
        reason = "checks_failed" if prev.get("last_terminal") != key else ""
    elif sha:
        key = f"success:{sha}"
        reason = "checks_success" if prev.get("last_terminal") != key else ""
    else:
        reason = ""

    if reason in ("checks_failed", "checks_success"):
        prev["last_terminal"] = f"{reason.split('_')[1]}:{sha}"
        if reason == "checks_failed":
            prev["last_terminal"] = f"failed:{sha}"
            prev["failed"] = failed
        else:
            prev["last_terminal"] = f"success:{sha}"
            prev["failed"] = []

prev["state"] = cur_state
prev["sha"] = sha
prev["done"] = done
json.dump(prev, open(state_path, "w"))
if reason:
    failed_out = "|".join(prev.get("failed") or [])
    print(f"{reason}\t{sha}\t{failed_out}")
PY
}

activate
REMAINING=${#TARGETS[@]}
TICK=0
echo "watch-pr-checks: watching ${TARGETS[*]} every ${INTERVAL}s kickoff=$KICKOFF (activate=${ACTIVATE_SCRIPT:-ambient-gh})" >&2

declare -a REPOS NUMS
i=0
while [[ $i -lt ${#TARGETS[@]} ]]; do
  t="${TARGETS[$i]}"
  repo="${t%%#*}"
  num="${t##*#}"
  if [[ "$repo" == "$t" || -z "$num" ]]; then
    echo "watch-pr-checks: bad target '$t' (want owner/repo#N)" >&2
    exit 2
  fi
  REPOS+=("$repo")
  NUMS+=("$num")
  write_state '{"state":"OPEN","sha":"","last_terminal":"","failed":[],"done":0}' \
    "$STATE_DIR/$i"
  i=$((i + 1))
done

if [[ "$KICKOFF" -eq 1 ]]; then
  i=0
  while [[ $i -lt ${#TARGETS[@]} ]]; do
    emit_wake "${TARGETS[$i]}" "${REPOS[$i]}" "${NUMS[$i]}" "kickoff" "$REMAINING"
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
    if [[ "$(read_field "$STATE_DIR/$i" done)" != "1" ]]; then
      line=$(poll_target "$STATE_DIR/$i" "${REPOS[$i]}" "${NUMS[$i]}" || true)
      if [[ -n "${line:-}" ]]; then
        reason="${line%%	*}"
        rest="${line#*	}"
        sha="${rest%%	*}"
        failed="${rest#*	}"
        if [[ "$reason" == "pr_merged" || "$reason" == "pr_closed" ]]; then
          REMAINING=$((REMAINING - 1))
        fi
        emit_wake "${TARGETS[$i]}" "${REPOS[$i]}" "${NUMS[$i]}" \
          "$reason" "$REMAINING" "$sha" "$failed"
      fi
    fi
    i=$((i + 1))
  done

  if [[ "$REMAINING" -gt 0 ]]; then
    sleep "$INTERVAL"
  fi
done

echo "watch-pr-checks: all targets merged/closed; exiting" >&2
