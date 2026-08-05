#!/usr/bin/env bash
# Watch live-verify PRs: on new head SHA, dispatch a deploy workflow, then wake
# when that deploy finishes so the human can re-smoke before Approve/merge.
#
# Usage:
#   bash .claude/skills/deploy-verify-watch/scripts/watch-deploy-verify.sh \
#     --interval 30 \
#     [--activate ~/.config/rosetta/github-app-activate.sh] \
#     [--workflow "Deploy Organization"] \
#     [--environment dev] \
#     [--frontend|--no-frontend] [--backend] [--dns] \
#     [--auto-dispatch|--no-auto-dispatch] \
#     [--dispatch-on-arm] \
#     [--kickoff] \
#     Rosetta-Foundation/rosetta_dev-scripts#1
#
# Classify only (exit 0 = needs live verify):
#   bash …/watch-deploy-verify.sh --classify Owner/repo#N
#
# Sentinel (stdout): AGENT_LOOP_WAKE_deploy_verify <json>
# Pair with Cursor agent loop notify_on_output on ^AGENT_LOOP_WAKE_deploy_verify.
#
# Wake reasons: kickoff | head_pushed | deploy_dispatched | deploy_green |
#               deploy_failed | pr_merged | pr_closed
set -euo pipefail

INTERVAL=30
ACTIVATE=""
WORKFLOW="Deploy Organization"
ENVIRONMENT="dev"
FRONTEND=1
BACKEND=0
DNS=0
AUTO_DISPATCH=1
DISPATCH_ON_ARM=0
KICKOFF=0
CLASSIFY_ONLY=""
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
    --workflow)
      WORKFLOW="${2:?}"
      shift 2
      ;;
    --workflow=*)
      WORKFLOW="${1#*=}"
      shift
      ;;
    --environment)
      ENVIRONMENT="${2:?}"
      shift 2
      ;;
    --environment=*)
      ENVIRONMENT="${1#*=}"
      shift
      ;;
    --frontend)
      FRONTEND=1
      shift
      ;;
    --no-frontend)
      FRONTEND=0
      shift
      ;;
    --backend)
      BACKEND=1
      shift
      ;;
    --dns)
      DNS=1
      shift
      ;;
    --auto-dispatch)
      AUTO_DISPATCH=1
      shift
      ;;
    --no-auto-dispatch)
      AUTO_DISPATCH=0
      shift
      ;;
    --dispatch-on-arm)
      DISPATCH_ON_ARM=1
      shift
      ;;
    --kickoff)
      KICKOFF=1
      shift
      ;;
    --classify)
      CLASSIFY_ONLY="${2:?}"
      shift 2
      ;;
    --classify=*)
      CLASSIFY_ONLY="${1#*=}"
      shift
      ;;
    -h|--help)
      sed -n '2,28p' "$0"
      exit 0
      ;;
    *)
      TARGETS+=("$1")
      shift
      ;;
  esac
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

activate() {
  if [[ -z "$ACTIVATE_SCRIPT" ]]; then
    return 0
  fi
  if [[ ! -f "$ACTIVATE_SCRIPT" ]]; then
    echo "watch-deploy-verify: activate script not found: $ACTIVATE_SCRIPT" >&2
    exit 1
  fi
  # shellcheck disable=SC1090
  eval "$(bash "$ACTIVATE_SCRIPT")"
}

# Prints "1" if the PR needs a live host smoke before merge; else "0".
classify_pr() {
  local repo="$1" num="$2"
  REPO="$repo" NUM="$num" python3 - <<'PY'
import json, os, re, subprocess, sys

repo, num = os.environ["REPO"], os.environ["NUM"]

def gh_json(args):
    out = subprocess.check_output(["gh", *args], text=True, stderr=subprocess.DEVNULL)
    return json.loads(out)

try:
    pr = gh_json([
        "pr", "view", num, "-R", repo,
        "--json", "title,body,labels,files",
    ])
except Exception:
    print(0)
    sys.exit(0)

labels = {(l.get("name") or "").lower() for l in (pr.get("labels") or [])}
if "verify-live" in labels or "live-verify" in labels:
    print(1)
    sys.exit(0)

text = f"{pr.get('title') or ''}\n{pr.get('body') or ''}".lower()
keyword_re = re.compile(
    r"redirect_uri|\blogout\b|\bcookie\b|\bsso\b|phase\s*0e|\bcutover\b|"
    r"post-login|accounts\.dev|admit\.dev|auth\s*handoff|multi-spa",
    re.I,
)
if keyword_re.search(text):
    print(1)
    sys.exit(0)

path_re = re.compile(
    r"(^|/)("
    r"accounts-frontend|"
    r"AccountsAuthRedirect|"
    r"accounts-redirect|"
    r"return-to|"
    r"session-expiry|"
    r"deploy-organization\.yml|"
    r"frontend-accounts-stack|"
    r"frontend-app\.ts|"
    r"cookieSso|"
    r"platform/accounts"
    r")",
    re.I,
)
for f in pr.get("files") or []:
    path = f.get("path") or ""
    if path_re.search(path):
        print(1)
        sys.exit(0)

print(0)
PY
}

if [[ -n "$CLASSIFY_ONLY" ]]; then
  activate
  repo="${CLASSIFY_ONLY%%#*}"
  num="${CLASSIFY_ONLY##*#}"
  if [[ "$repo" == "$CLASSIFY_ONLY" || -z "$num" ]]; then
    echo "watch-deploy-verify: bad --classify target (want owner/repo#N)" >&2
    exit 2
  fi
  needs=$(classify_pr "$repo" "$num")
  if [[ "${needs:-0}" -gt 0 ]]; then
    echo "live-verify: yes $CLASSIFY_ONLY" >&2
    exit 0
  fi
  echo "live-verify: no $CLASSIFY_ONLY" >&2
  exit 1
fi

if [[ ${#TARGETS[@]} -eq 0 ]]; then
  echo "usage: $0 [--interval SECONDS] [--activate PATH] [--workflow NAME] [--environment ENV] [--frontend|--no-frontend] [--backend] [--dns] [--auto-dispatch|--no-auto-dispatch] [--dispatch-on-arm] [--kickoff] owner/repo#N [...]" >&2
  echo "   or: $0 --classify owner/repo#N" >&2
  exit 2
fi

if [[ "$FRONTEND" -eq 0 && "$BACKEND" -eq 0 && "$DNS" -eq 0 ]]; then
  echo "watch-deploy-verify: enable at least one of --frontend / --backend / --dns" >&2
  exit 2
fi

emit_wake() {
  local target="$1" repo="$2" num="$3" reason="$4" remaining="$5"
  local sha="${6:-}" run_id="${7:-}" run_url="${8:-}" branch="${9:-}"
  local payload
  payload=$(
    TARGET="$target" REPO="$repo" NUM="$num" REASON="$reason" REMAINING="$remaining" \
    SHA="$sha" RUN_ID="$run_id" RUN_URL="$run_url" BRANCH="$branch" \
    WORKFLOW="$WORKFLOW" ENVIRONMENT="$ENVIRONMENT" python3 - <<'PY'
import json, os
reason = os.environ["REASON"]
target = os.environ["TARGET"]
sha = os.environ.get("SHA") or ""
run_url = os.environ.get("RUN_URL") or ""
workflow = os.environ.get("WORKFLOW") or "Deploy Organization"
env = os.environ.get("ENVIRONMENT") or "dev"
prompt = (
    f"Deploy-verify wake ({reason}) for {target}. "
    "Activate the workspace GitHub App (Addi). "
)
if reason == "deploy_green":
    prompt += (
        f"Live deploy of {workflow} to {env} succeeded"
        + (f" for SHA {sha[:12]}" if sha else "")
        + (f" — {run_url}" if run_url else "")
        + ". Tell the human the environment is ready to re-smoke "
        "(auth/logout/redirect/cookie paths as applicable). "
        "Do not merge until they confirm (or Approve lands via pr-approve-watch). "
    )
elif reason == "deploy_failed":
    prompt += (
        f"Live deploy of {workflow} to {env} failed"
        + (f" for SHA {sha[:12]}" if sha else "")
        + (f" — {run_url}" if run_url else "")
        + ". Retrieve failed logs, remediate, push, and keep this watcher armed "
        "so the next SHA auto-dispatches. "
    )
elif reason == "head_pushed":
    prompt += (
        f"New head SHA {sha[:12]} on the PR. "
        "A deploy should auto-dispatch (or was dispatched). "
        "Wait for deploy_green/deploy_failed; do not ask the human to re-smoke yet. "
    )
elif reason == "deploy_dispatched":
    prompt += (
        f"Dispatched {workflow} ({env}) for SHA {sha[:12]}"
        + (f" — {run_url}" if run_url else "")
        + ". Wait for completion; on green, prompt the human to re-smoke. "
    )
elif reason in ("pr_merged", "pr_closed"):
    prompt += f"PR is {reason.replace('pr_', '')}. Confirm Done-when / report; stop deploy-verify for this target. "
else:
    prompt += (
        "Live-verify PR armed. Ensure a deploy is in flight for the current head "
        "(dispatch if needed), then on deploy_green ask the human to re-smoke "
        "before Approve/merge. "
    )
prompt += "Keep watching remaining open targets."
print(json.dumps({
    "prompt": prompt,
    "repo": os.environ["REPO"],
    "number": int(os.environ["NUM"]),
    "target": target,
    "reason": reason,
    "remaining": int(os.environ["REMAINING"]),
    "sha": sha,
    "runId": os.environ.get("RUN_ID") or "",
    "runUrl": run_url,
    "branch": os.environ.get("BRANCH") or "",
    "workflow": workflow,
    "environment": env,
}))
PY
  )
  printf 'AGENT_LOOP_WAKE_deploy_verify %s\n' "$payload"
  echo "watch-deploy-verify: $reason → $target (remaining=$remaining)" >&2
}

STATE_DIR=$(mktemp -d "${TMPDIR:-/tmp}/deploy-verify-watch.XXXXXX")
cleanup() { rm -rf "$STATE_DIR"; }
trap cleanup EXIT

write_state() {
  local file="$1"
  shift
  printf '%s\n' "$1" >"$file"
}

read_field() {
  local file="$1" field="$2"
  python3 -c "import json; print(json.load(open('$file')).get('$field', ''))"
}

init_target_state() {
  local file="$1" repo="$2" num="$3"
  local meta
  meta=$(
    gh pr view "$num" -R "$repo" --json state,headRefName,headRefOid \
      --jq '{state,branch:.headRefName,sha:.headRefOid}' 2>/dev/null || echo '{}'
  )
  write_state "$file" "$(
    META="$meta" python3 - <<'PY'
import json, os
meta = json.loads(os.environ["META"] or "{}")
state = meta.get("state") or "OPEN"
print(json.dumps({
  "sha": meta.get("sha") or "",
  "branch": meta.get("branch") or "",
  "state": state,
  "dispatched_sha": "",
  "pending_run": "",
  "last_green_sha": "",
  "last_failed_run": "",
  "done": 1 if state in ("MERGED", "CLOSED") else 0,
}))
PY
  )"
}

dispatch_deploy() {
  local repo="$1" branch="$2"
  local -a fields=()
  fields+=(-f "environment=${ENVIRONMENT}")
  if [[ "$FRONTEND" -eq 1 ]]; then
    fields+=(-f "frontend=true")
  else
    fields+=(-f "frontend=false")
  fi
  if [[ "$BACKEND" -eq 1 ]]; then
    fields+=(-f "backend=true")
  else
    fields+=(-f "backend=false")
  fi
  if [[ "$DNS" -eq 1 ]]; then
    fields+=(-f "dns=true")
  else
    fields+=(-f "dns=false")
  fi
  gh workflow run "$WORKFLOW" -R "$repo" --ref "$branch" "${fields[@]}" >&2
}

find_run_for_sha() {
  local repo="$1" branch="$2" sha="$3"
  REPO="$repo" BRANCH="$branch" SHA="$sha" WORKFLOW="$WORKFLOW" python3 - <<'PY'
import json, os, subprocess, sys

repo = os.environ["REPO"]
branch = os.environ["BRANCH"]
sha = os.environ["SHA"]
workflow = os.environ["WORKFLOW"]

def gh_json(args):
    out = subprocess.check_output(["gh", *args], text=True, stderr=subprocess.DEVNULL)
    return json.loads(out)

try:
    runs = gh_json([
        "run", "list", "-R", repo,
        "--workflow", workflow,
        "--branch", branch,
        "--limit", "15",
        "--json", "databaseId,headSha,status,conclusion,url,event,createdAt",
    ])
except Exception:
    print("")
    sys.exit(0)

# Prefer workflow_dispatch matching SHA; else any matching SHA.
dispatch = [r for r in runs if r.get("headSha") == sha and r.get("event") == "workflow_dispatch"]
any_sha = [r for r in runs if r.get("headSha") == sha]
pick = (dispatch or any_sha)
if not pick:
    print("")
    sys.exit(0)
# Newest first from gh; take first
r = pick[0]
print(f"{r.get('databaseId')}|{r.get('status')}|{r.get('conclusion') or ''}|{r.get('url') or ''}")
PY
}

# stdout: reason|sha|run_id|run_url|branch  (reason may be empty)
poll_target() {
  local file="$1" repo="$2" num="$3"
  FILE="$file" REPO="$repo" NUM="$num" WORKFLOW="$WORKFLOW" \
  AUTO_DISPATCH="$AUTO_DISPATCH" FRONTEND="$FRONTEND" BACKEND="$BACKEND" DNS="$DNS" \
  ENVIRONMENT="$ENVIRONMENT" python3 - <<'PY'
import json, os, subprocess, time

state_path = os.environ["FILE"]
repo = os.environ["REPO"]
num = os.environ["NUM"]
workflow = os.environ["WORKFLOW"]
auto = os.environ.get("AUTO_DISPATCH") == "1"
prev = json.load(open(state_path))

def gh_json(args):
    out = subprocess.check_output(["gh", *args], text=True, stderr=subprocess.DEVNULL)
    return json.loads(out)

def gh_run(args):
    subprocess.check_call(["gh", *args], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

try:
    pr = gh_json([
        "pr", "view", num, "-R", repo,
        "--json", "state,headRefName,headRefOid",
    ])
except Exception:
    print("")
    raise SystemExit(0)

state = pr.get("state") or "OPEN"
branch = pr.get("headRefName") or ""
sha = pr.get("headRefOid") or ""
reason = ""
run_id = prev.get("pending_run") or ""
run_url = ""
dispatched_sha = prev.get("dispatched_sha") or ""
last_green = prev.get("last_green_sha") or ""
last_failed_run = prev.get("last_failed_run") or ""

if state == "MERGED":
    reason = "pr_merged"
elif state == "CLOSED":
    reason = "pr_closed"
else:
    prev_sha = prev.get("sha") or ""
    if sha and sha != prev_sha and prev_sha:
        reason = "head_pushed"

    # Auto-dispatch on new SHA (or never dispatched)
    if auto and sha and branch and dispatched_sha != sha:
        fields = [
            "workflow", "run", workflow, "-R", repo, "--ref", branch,
            "-f", f"environment={os.environ.get('ENVIRONMENT') or 'dev'}",
            "-f", f"frontend={'true' if os.environ.get('FRONTEND') == '1' else 'false'}",
            "-f", f"backend={'true' if os.environ.get('BACKEND') == '1' else 'false'}",
            "-f", f"dns={'true' if os.environ.get('DNS') == '1' else 'false'}",
        ]
        try:
            gh_run(fields)
            dispatched_sha = sha
            run_id = ""
            # Brief wait so the run appears in the list
            time.sleep(3)
            # Prefer deploy_dispatched over head_pushed when both apply.
            reason = "deploy_dispatched"
        except Exception:
            pass

    # Resolve run for current SHA
    try:
        runs = gh_json([
            "run", "list", "-R", repo,
            "--workflow", workflow,
            "--branch", branch,
            "--limit", "15",
            "--json", "databaseId,headSha,status,conclusion,url,event",
        ])
    except Exception:
        runs = []

    match = None
    for r in runs:
        if r.get("headSha") == sha and r.get("event") == "workflow_dispatch":
            match = r
            break
    if match is None:
        for r in runs:
            if r.get("headSha") == sha:
                match = r
                break

    if match is not None:
        run_id = str(match.get("databaseId") or "")
        run_url = match.get("url") or ""
        status = match.get("status") or ""
        conclusion = match.get("conclusion") or ""
        if status == "completed" and conclusion == "success" and sha != last_green:
            reason = "deploy_green"
            last_green = sha
        elif status == "completed" and conclusion not in ("", "success", "skipped", "cancelled"):
            if run_id != last_failed_run:
                reason = "deploy_failed"
                last_failed_run = run_id

done = 1 if reason in ("pr_merged", "pr_closed") or state in ("MERGED", "CLOSED") else 0
json.dump(
    {
        "sha": sha,
        "branch": branch,
        "state": state,
        "dispatched_sha": dispatched_sha,
        "pending_run": run_id,
        "last_green_sha": last_green,
        "last_failed_run": last_failed_run,
        "done": done,
    },
    open(state_path, "w"),
)
# reason|sha|run_id|run_url|branch
print("|".join([reason, sha, run_id, run_url, branch]))
PY
}

maybe_dispatch_arm() {
  local file="$1" repo="$2" num="$3" target="$4"
  local sha branch run_line run_id run_url
  sha=$(read_field "$file" sha)
  branch=$(read_field "$file" branch)
  if [[ -z "$sha" || -z "$branch" ]]; then
    return 0
  fi
  if [[ "$AUTO_DISPATCH" -ne 1 && "$DISPATCH_ON_ARM" -ne 1 ]]; then
    return 0
  fi
  # Skip if a successful deploy already exists for this SHA
  run_line=$(find_run_for_sha "$repo" "$branch" "$sha" || true)
  if [[ -n "$run_line" ]]; then
    IFS='|' read -r run_id status conclusion run_url <<<"$run_line"
    if [[ "$status" == "completed" && "$conclusion" == "success" ]]; then
      write_state "$file" "$(
        FILE="$file" SHA="$sha" RUN="$run_id" python3 - <<'PY'
import json, os
s = json.load(open(os.environ["FILE"]))
s["dispatched_sha"] = os.environ["SHA"]
s["pending_run"] = os.environ["RUN"]
s["last_green_sha"] = os.environ["SHA"]
print(json.dumps(s))
PY
      )"
      return 0
    fi
    if [[ "$status" != "completed" ]]; then
      write_state "$file" "$(
        FILE="$file" SHA="$sha" RUN="$run_id" python3 - <<'PY'
import json, os
s = json.load(open(os.environ["FILE"]))
s["dispatched_sha"] = os.environ["SHA"]
s["pending_run"] = os.environ["RUN"]
print(json.dumps(s))
PY
      )"
      return 0
    fi
  fi
  echo "watch-deploy-verify: dispatching $WORKFLOW ($ENVIRONMENT) for $target @ ${sha:0:12} on $branch" >&2
  dispatch_deploy "$repo" "$branch"
  sleep 4
  run_line=$(find_run_for_sha "$repo" "$branch" "$sha" || true)
  IFS='|' read -r run_id status conclusion run_url <<<"${run_line:-|||}"
  write_state "$file" "$(
    FILE="$file" SHA="$sha" RUN="$run_id" python3 - <<'PY'
import json, os
s = json.load(open(os.environ["FILE"]))
s["dispatched_sha"] = os.environ["SHA"]
s["pending_run"] = os.environ.get("RUN") or ""
print(json.dumps(s))
PY
  )"
  emit_wake "$target" "$repo" "$num" "deploy_dispatched" "$REMAINING" "$sha" "$run_id" "$run_url" "$branch"
}

activate
REMAINING=${#TARGETS[@]}
TICK=0
echo "watch-deploy-verify: watching ${TARGETS[*]} every ${INTERVAL}s workflow='$WORKFLOW' env=$ENVIRONMENT auto_dispatch=$AUTO_DISPATCH (activate=${ACTIVATE_SCRIPT:-ambient-gh})" >&2

declare -a REPOS NUMS
i=0
while [[ $i -lt ${#TARGETS[@]} ]]; do
  t="${TARGETS[$i]}"
  repo="${t%%#*}"
  num="${t##*#}"
  if [[ "$repo" == "$t" || -z "$num" ]]; then
    echo "watch-deploy-verify: bad target '$t' (want owner/repo#N)" >&2
    exit 2
  fi
  REPOS+=("$repo")
  NUMS+=("$num")
  needs=$(classify_pr "$repo" "$num" || echo 0)
  if [[ "${needs:-0}" -eq 0 ]]; then
    echo "watch-deploy-verify: warn $t did not match live-verify heuristics (still watching; use label verify-live to be explicit)" >&2
  else
    echo "watch-deploy-verify: classified $t as live-verify" >&2
  fi
  init_target_state "$STATE_DIR/$i" "$repo" "$num"
  if [[ "$(read_field "$STATE_DIR/$i" done)" == "1" ]]; then
    REMAINING=$((REMAINING - 1))
  fi
  i=$((i + 1))
done

i=0
while [[ $i -lt ${#TARGETS[@]} ]]; do
  if [[ "$(read_field "$STATE_DIR/$i" done)" != "1" ]]; then
    if [[ "$DISPATCH_ON_ARM" -eq 1 || "$AUTO_DISPATCH" -eq 1 ]]; then
      maybe_dispatch_arm "$STATE_DIR/$i" "${REPOS[$i]}" "${NUMS[$i]}" "${TARGETS[$i]}"
    fi
    if [[ "$KICKOFF" -eq 1 ]]; then
      emit_wake "${TARGETS[$i]}" "${REPOS[$i]}" "${NUMS[$i]}" "kickoff" "$REMAINING" \
        "$(read_field "$STATE_DIR/$i" sha)" \
        "$(read_field "$STATE_DIR/$i" pending_run)" \
        "" \
        "$(read_field "$STATE_DIR/$i" branch)"
    fi
  fi
  i=$((i + 1))
done

while [[ "$REMAINING" -gt 0 ]]; do
  TICK=$((TICK + 1))
  if (( TICK % 90 == 0 )); then
    activate
  fi

  i=0
  while [[ $i -lt ${#TARGETS[@]} ]]; do
    if [[ "$(read_field "$STATE_DIR/$i" done)" != "1" ]]; then
      line=$(poll_target "$STATE_DIR/$i" "${REPOS[$i]}" "${NUMS[$i]}" || true)
      IFS='|' read -r reason sha run_id run_url branch <<<"${line:-||||}"
      if [[ -n "${reason:-}" ]]; then
        if [[ "$reason" == "pr_merged" || "$reason" == "pr_closed" ]]; then
          REMAINING=$((REMAINING - 1))
        fi
        emit_wake "${TARGETS[$i]}" "${REPOS[$i]}" "${NUMS[$i]}" "$reason" "$REMAINING" \
          "$sha" "$run_id" "$run_url" "$branch"
      fi
    fi
    i=$((i + 1))
  done

  if [[ "$REMAINING" -gt 0 ]]; then
    sleep "$INTERVAL"
  fi
done

echo "watch-deploy-verify: all targets merged/closed; exiting" >&2
