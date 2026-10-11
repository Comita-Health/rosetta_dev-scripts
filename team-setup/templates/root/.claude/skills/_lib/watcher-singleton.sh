#!/usr/bin/env bash
# Per-target locks for session-mortal watchers (deploy-verify, pr-checks,
# issue-resolve). A second arm of the same kind+target exits 0 instead of
# starting another poll loop — and another --dispatch-on-arm deploy.
#
# mkdir is the lock (atomic on POSIX). The kernel does not release a
# directory, so we store a PID and reclaim when that PID is dead.
#
# Usage (after parsing TARGETS):
#   source this file
#   claim_watch_targets KIND target [target...]
#   # CLAIMED_TARGETS / SKIPPED_TARGETS are set
#   trap 'release_watch_locks' EXIT
#
# Override lock root in tests: WATCHER_LOCK_ROOT=/tmp/...

WATCHER_LOCK_ROOT="${WATCHER_LOCK_ROOT:-${HOME}/.rosetta/locks/watchers}"
WATCH_CLAIMED_LOCKS=()
CLAIMED_TARGETS=()
SKIPPED_TARGETS=()

sanitize_watch_lock_part() {
  printf '%s' "$1" | tr '/# :' '____' | tr -cd 'A-Za-z0-9._-'
}

watch_lock_dir_for() {
  local kind="$1" target="$2"
  printf '%s/%s/%s' "$WATCHER_LOCK_ROOT" \
    "$(sanitize_watch_lock_part "$kind")" \
    "$(sanitize_watch_lock_part "$target")"
}

watch_pid_alive() {
  local pid="${1:-}"
  [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null
}

release_watch_locks() {
  local dir
  for dir in "${WATCH_CLAIMED_LOCKS[@]+"${WATCH_CLAIMED_LOCKS[@]}"}"; do
    rm -rf "$dir"
  done
  WATCH_CLAIMED_LOCKS=()
}

try_claim_watch_target() {
  local kind="$1" target="$2"
  local dir pid
  dir=$(watch_lock_dir_for "$kind" "$target")
  mkdir -p "$(dirname "$dir")"
  if mkdir "$dir" 2>/dev/null; then
    printf '%s\n' "$$" >"$dir/pid"
    printf '%s\n' "$target" >"$dir/target"
    WATCH_CLAIMED_LOCKS+=("$dir")
    return 0
  fi
  pid=$(cat "$dir/pid" 2>/dev/null || true)
  if watch_pid_alive "$pid"; then
    return 1
  fi
  rm -rf "$dir"
  if mkdir "$dir" 2>/dev/null; then
    printf '%s\n' "$$" >"$dir/pid"
    printf '%s\n' "$target" >"$dir/target"
    WATCH_CLAIMED_LOCKS+=("$dir")
    return 0
  fi
  return 1
}

# claim_watch_targets KIND TARGET [TARGET...]
claim_watch_targets() {
  local kind="$1"
  shift
  CLAIMED_TARGETS=()
  SKIPPED_TARGETS=()
  local t
  for t in "$@"; do
    if try_claim_watch_target "$kind" "$t"; then
      CLAIMED_TARGETS+=("$t")
    else
      SKIPPED_TARGETS+=("$t")
    fi
  done
}
