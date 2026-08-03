#!/usr/bin/env bash
# SDLC continuity daemon — one tick.
#
# launchd runs this every 60s. It is the piece that keeps the pipeline moving
# when no agent and no terminal is alive: agent-spawned watcher shells die
# with the tool call that started them, and Cursor's notify_on_output cannot
# begin a turn after its arming turn ends. A launchd job has neither problem.
#
# Each tick:
#   1. Relaunch supervisors whose pid is dead while the run is unfinished.
#   2. Kill implementation agents that have blown their wall-clock budget.
#   3. Wake the agent when a needs-human issue has been closed.
#
# Everything it wants an agent to do is written to the durable wake inbox, so
# the signal waits patiently rather than being printed into the void.
#
# Run one tick by hand:  bash scripts/sdlc-continuity-daemon.sh --once
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./wake-inbox.sh
source "$SCRIPT_DIR/wake-inbox.sh"

RUNS_DIR="${SDLC_RUNS_DIR:-$HOME/.rosetta/sdlc-runs}"
STATE_DIR="${ROSETTA_WAKE_DIR:-$HOME/.rosetta/wake}"
LOG_FILE="${SDLC_DAEMON_LOG:-$HOME/.rosetta/sdlc-daemon.log}"
# An implementation agent that has not touched its heartbeat in this long is
# hung, not slow. Generous: real tasks routinely run 10+ minutes.
AGENT_STALL_SECONDS="${SDLC_AGENT_STALL_SECONDS:-2400}"
# Only auto-relaunch runs that were active recently. The daemon exists to
# survive a crash mid-run, not to resurrect experiments someone abandoned
# yesterday — restarting those burns tokens and opens PRs nobody asked for.
# Older runs get one wake instead, so the human decides.
ABANDONED_SECONDS="${SDLC_ABANDONED_SECONDS:-7200}"

mkdir -p "$(dirname "$LOG_FILE")" "$STATE_DIR"
wake_init

log() {
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >>"$LOG_FILE"
}

pid_alive() {
  [[ -n "${1:-}" ]] && kill -0 "$1" 2>/dev/null
}

# Terminal runs must not be relaunched — that is an infinite restart loop.
run_is_finished() {
  local state_file="$1"
  python3 - "$state_file" <<'PY'
import json, sys
try:
    with open(sys.argv[1]) as handle:
        state = json.load(handle)
except (OSError, json.JSONDecodeError):
    sys.exit(0)  # unreadable: treat as finished, never relaunch blindly

results = state.get("taskResults") or {}
if not results:
    sys.exit(1)
# Finished when every task that exists has been merged.
sys.exit(0 if all(r.get("mergedSha") for r in results.values()) else 1)
PY
}

relaunch_supervisor() {
  local run_dir="$1" run_id="$2" launch_file="$run_dir/launch.json"

  if [[ ! -f "$launch_file" ]]; then
    log "  $run_id: no launch.json — cannot relaunch, escalating"
    wake_emit_once sdlc_supervisor "$run_id-no-launch-record" \
      "SDLC run ${run_id} has a dead supervisor and no launch.json, so the daemon cannot relaunch it. Relaunch it by hand with 'run --supervise --detach'." \
      "$(printf '{"runId":"%s"}' "$run_id")" >/dev/null
    return
  fi

  local cwd exec_path
  cwd=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("cwd",""))' "$launch_file")
  exec_path=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("execPath",""))' "$launch_file")

  if [[ ! -d "$cwd" || ! -x "$exec_path" ]]; then
    log "  $run_id: launch.json unusable (cwd=$cwd exec=$exec_path)"
    return
  fi

  # Read argv as NUL-delimited so paths with spaces survive. `execArgv` carries
  # the interpreter flags (the tsx loader when the engine runs from source);
  # without replaying them the command is `node src/index.ts`, which dies on
  # ERR_UNKNOWN_FILE_EXTENSION before reading anything.
  local -a argv=()
  while IFS= read -r -d '' item; do
    argv+=("$item")
  done < <(python3 -c '
import json, sys
record = json.load(open(sys.argv[1]))
for a in list(record.get("execArgv", [])) + list(record.get("argv", [])):
    sys.stdout.write(a + "\0")
' "$launch_file")

  if [[ ${#argv[@]} -eq 0 ]]; then
    log "  $run_id: launch.json has empty argv"
    return
  fi

  # Records written before execArgv was captured still say `node <file>.ts`.
  # Route those through tsx rather than spawning a guaranteed crash loop.
  if [[ "${argv[0]}" == *.ts && -x "$(command -v bunx || true)" ]]; then
    local -a tsx_argv=(tsx "${argv[@]}")
    argv=("${tsx_argv[@]}")
    exec_path="$(command -v bunx)"
  fi

  (
    cd "$cwd" || exit 1
    nohup "$exec_path" "${argv[@]}" >>"$run_dir/supervise.log" 2>&1 &
    printf '%s\n' "$!" >"$run_dir/supervise.pid"
  )
  local new_pid
  new_pid=$(cat "$run_dir/supervise.pid" 2>/dev/null || echo "?")

  # A child that dies on startup must not be reported as a restart. Claiming
  # "restarted, confirm it is progressing" for a process that never ran sends
  # the human to look at a healthy-looking run while nothing is happening, and
  # the next tick simply spawns another corpse.
  sleep "${SDLC_RELAUNCH_PROBE_SECONDS:-3}"
  if ! pid_alive "$new_pid"; then
    log "  $run_id: relaunched pid $new_pid died during startup — not retrying"
    rm -f "$run_dir/supervise.pid"
    wake_emit_once sdlc_supervisor "$run_id-relaunch-failed" \
      "The continuity daemon tried to relaunch SDLC run ${run_id} and the child died immediately. See the tail of ${run_dir}/supervise.log; the run needs a manual 'run --supervise --detach'." \
      "$(printf '{"runId":"%s"}' "$run_id")" >/dev/null
    return
  fi

  log "  $run_id: relaunched supervisor as pid $new_pid"
  wake_emit sdlc_supervisor "$run_id-restarted" \
    "The SDLC supervisor for ${run_id} had died and the continuity daemon restarted it (pid ${new_pid}). Check the run status and confirm it is making progress." \
    "$(printf '{"runId":"%s","pid":"%s"}' "$run_id" "$new_pid")" >/dev/null
}

# Kill an implementation agent whose heartbeat has gone quiet, so the wave
# fails fast and the next tick can retry instead of hanging indefinitely.
check_hung_agent() {
  local run_dir="$1" run_id="$2" hb="$run_dir/heartbeat.jsonl"
  [[ -f "$hb" ]] || return 0

  local age
  age=$(python3 - "$hb" "$AGENT_STALL_SECONDS" <<'PY'
import json, os, sys, time
path, limit = sys.argv[1], int(sys.argv[2])
try:
    with open(path, "rb") as handle:
        handle.seek(0, os.SEEK_END)
        size = handle.tell()
        handle.seek(max(0, size - 8192))
        lines = [l for l in handle.read().decode("utf-8", "replace").splitlines() if l.strip()]
except OSError:
    print(-1); sys.exit()

if not lines:
    print(-1); sys.exit()

try:
    last = json.loads(lines[-1])
except json.JSONDecodeError:
    print(-1); sys.exit()

# Only an in-flight implementation step can be "hung"; idle runs are fine.
if last.get("step") != "implementation" or not last.get("agentAlive"):
    print(-1); sys.exit()

age = time.time() - os.path.getmtime(path)
print(int(age) if age > limit else -1)
PY
)

  if [[ "${age:--1}" -le 0 ]]; then
    # Healthy again: re-arm so a future stall is reported.
    wake_reset_once sdlc_agent_timeout "$run_id-agent-stalled"
    return 0
  fi

  if [[ "${age:--1}" -gt 0 ]]; then
    # A killed agent never touches its heartbeat again, so this condition is
    # permanent once it fires. Re-logging and re-killing on every 60s tick
    # buries every other run's output — one abandoned run produced 800 lines
    # of "stalled — killing" over 13 hours while nothing else was visible.
    if wake_notified sdlc_agent_timeout "$run_id-agent-stalled"; then
      return 0
    fi

    log "  $run_id: implementation agent stalled ${age}s — killing"
    pkill -f "cursor-agent.*${run_id}" 2>/dev/null || true
    wake_emit_once sdlc_agent_timeout "$run_id-agent-stalled" \
      "The implementation agent for SDLC run ${run_id} was stalled for ${age}s and the daemon killed it. Review the task transcript for a loop, then resume the run." \
      "$(printf '{"runId":"%s","stalledSeconds":%s}' "$run_id" "$age") " >/dev/null
  fi
}

# A closed needs-human issue is the human saying "I cleared it" — the loop
# should pick itself back up rather than wait to be told again.
check_cleared_blockers() {
  local run_dir="$1" run_id="$2" launch_file="$run_dir/launch.json"
  [[ -f "$launch_file" ]] || return 0
  command -v gh >/dev/null 2>&1 || return 0

  local repo_path engine_cwd
  repo_path=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("repoPath",""))' "$launch_file")
  engine_cwd=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("cwd",""))' "$launch_file")
  [[ -d "$repo_path" && -d "$engine_cwd" ]] || return 0

  local report
  report=$(cd "$engine_cwd" && bunx tsx src/index.ts blockers \
    --run-id "$run_id" --repo "$repo_path" --json 2>/dev/null) || return 0

  local resumable
  resumable=$(printf '%s' "$report" | python3 -c '
import json, sys
try:
    print("yes" if json.load(sys.stdin).get("resumable") else "no")
except Exception:
    print("no")
' 2>/dev/null)

  if [[ "$resumable" == "yes" ]]; then
    log "  $run_id: all needs-human blockers cleared"
    wake_emit_once sdlc_blocker "$run_id-blockers-cleared" \
      "Every needs-human issue for SDLC run ${run_id} has been closed. Verify the blockers really are resolved, then resume the run with 'run --supervise --detach'." \
      "$(printf '{"runId":"%s"}' "$run_id")" >/dev/null
  else
    # A new blocker reopened the condition — arm the notice again so the
    # next all-clear is not swallowed by the previous run's marker.
    wake_reset_once sdlc_blocker "$run_id-blockers-cleared"
  fi
}

tick() {
  [[ -d "$RUNS_DIR" ]] || return 0
  local run_dir run_id state_file pid

  for run_dir in "$RUNS_DIR"/*/; do
    [[ -d "$run_dir" ]] || continue
    run_id=$(basename "$run_dir")
    state_file="$run_dir/state.json"
    [[ -f "$state_file" ]] || continue

    if run_is_finished "$state_file"; then
      continue
    fi

    check_hung_agent "$run_dir" "$run_id"
    check_cleared_blockers "$run_dir" "$run_id"

    pid=$(cat "$run_dir/supervise.pid" 2>/dev/null || true)
    if [[ -n "$pid" ]] && ! pid_alive "$pid"; then
      local idle
      idle=$(python3 -c '
import os, sys, time
print(int(time.time() - os.path.getmtime(sys.argv[1])))
' "$state_file" 2>/dev/null || echo 0)

      if (( idle > ABANDONED_SECONDS )); then
        # Notify once (the wake is deduped by key), never auto-restart.
        log "$run_id: supervisor dead but run idle ${idle}s — abandoned, not relaunching"
        wake_emit_once sdlc_supervisor "$run_id-abandoned" \
          "SDLC run ${run_id} is unfinished with a dead supervisor and has been idle for $((idle / 3600))h. The daemon did not relaunch it. Decide whether to resume it or close it out." \
          "$(printf '{"runId":"%s","idleSeconds":%s}' "$run_id" "$idle")" >/dev/null
      else
        log "$run_id: supervisor pid $pid is dead and the run is unfinished"
        relaunch_supervisor "$run_dir" "$run_id"
      fi
    fi
  done
}

case "${1:-}" in
  --once|"")
    tick
    ;;
  -h|--help)
    sed -n '2,18p' "$0"
    ;;
  *)
    echo "usage: $0 [--once]" >&2
    exit 2
    ;;
esac
