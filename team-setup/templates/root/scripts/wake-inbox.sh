#!/usr/bin/env bash
# Durable agent wake inbox.
#
# The stdout sentinel (`AGENT_LOOP_WAKE_*`) only reaches an agent that is
# already watching the terminal it was printed to, and Cursor's
# notify_on_output cannot start a turn once the arming turn has ended. So a
# wake printed while no agent is listening is simply lost, and the loop stops
# with nobody aware of it.
#
# This inbox makes a wake a file instead of a line of output. Producers append
# and exit; the Cursor stop hook drains it and returns a follow-up, so the wake
# survives a dead terminal, a finished turn, and a reboot.
#
# Source it, then call wake_emit:
#
#   source "$(dirname "$0")/wake-inbox.sh"
#   wake_emit pr_approve "Comita-Health/repo#12" "Approve fired for …" '{"pr":12}'
#
# Layout:
#   $ROSETTA_WAKE_DIR/pending/*.json    unread wakes
#   $ROSETTA_WAKE_DIR/consumed/*.json   drained, kept for audit

WAKE_ROOT="${ROSETTA_WAKE_DIR:-$HOME/.rosetta/wake}"
WAKE_PENDING="$WAKE_ROOT/pending"
WAKE_CONSUMED="$WAKE_ROOT/consumed"

wake_init() {
  mkdir -p "$WAKE_PENDING" "$WAKE_CONSUMED"
}

# Best-effort native OS alert, independent of any agent chat being open.
#
# The stop-hook drain (see cursor-stop-append.sh) only runs at the end of an
# agent turn, so a wake created while chat is fully idle — nobody typed
# anything, no turn is in flight — has no path to an agent until the human
# happens to start a new one. A system notification banner reaches the human
# directly, closing that idle-chat gap without needing an agent to be
# listening at all. Never allowed to fail the wake: notification delivery is
# strictly best-effort on top of the durable file, which is the source of
# truth either way.
wake_notify_system() {
  local kind="$1" prompt="$2"
  command -v osascript >/dev/null 2>&1 || return 0

  local body="${prompt:0:220}"
  osascript -e "display notification \"$(printf '%s' "$body" | sed 's/"/\\"/g')\" with title \"SDLC wake: ${kind}\" sound name \"Ping\"" \
    >/dev/null 2>&1 || true
}

# Filesystem-safe slug for a dedupe key.
wake_slug() {
  printf '%s' "$1" | tr -c 'A-Za-z0-9._-' '-' | cut -c1-96
}

# wake_emit <kind> <dedupe_key> <prompt> [data_json]
#
# Dedupe: one pending file per (kind, dedupe_key). Re-emitting the same wake
# overwrites rather than piling up, so a watcher looping every 20s cannot
# bury the agent under hundreds of identical files.
wake_emit() {
  local kind="$1" key="$2" prompt="$3" data="${4:-{\}}"
  wake_init

  local slug file tmp
  slug="$(wake_slug "${kind}-${key}")"
  file="$WAKE_PENDING/${slug}.json"
  tmp="${file}.tmp.$$"

  if ! KIND="$kind" KEY="$key" PROMPT="$prompt" DATA="$data" python3 - >"$tmp" <<'PY'
import json, os, sys, time

try:
    data = json.loads(os.environ.get("DATA") or "{}")
except json.JSONDecodeError:
    data = {"raw": os.environ.get("DATA", "")}

json.dump({
    "kind": os.environ["KIND"],
    "dedupeKey": os.environ["KEY"],
    "prompt": os.environ["PROMPT"],
    "data": data,
    "createdAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    "pid": os.getppid(),
}, sys.stdout)
PY
  then
    rm -f "$tmp"
    echo "wake-inbox: failed to write wake for ${kind}/${key}" >&2
    return 1
  fi

  # Atomic publish: a draining reader never sees a half-written file.
  mv -f "$tmp" "$file"

  wake_notify_system "$kind" "$prompt"

  # Still print the sentinel: an agent actively watching this terminal gets
  # woken immediately rather than waiting for the next stop-hook drain.
  printf 'AGENT_LOOP_WAKE_%s %s\n' "$kind" "$(cat "$file")"
}

# wake_emit_once <kind> <dedupe_key> <prompt> [data_json]
#
# For standing conditions rather than events. A 60s daemon would otherwise
# re-emit "this run is abandoned" on every tick, and because draining is
# destructive that would wake an agent on every single turn end — enough
# noise that the operator would disable the whole mechanism. A marker file
# makes the notice fire once per condition until it is explicitly reset.
wake_emit_once() {
  local kind="$1" key="$2"
  wake_init
  local marker_dir="$WAKE_ROOT/notified"
  mkdir -p "$marker_dir"

  local marker
  marker="$marker_dir/$(wake_slug "${kind}-${key}")"
  if [[ -e "$marker" ]]; then
    return 0
  fi

  if wake_emit "$@"; then
    : >"$marker"
  fi
}

# True when wake_emit_once has already fired for this condition. Callers use
# it to skip side effects the first notice already covered — logging and
# killing on every tick of a standing condition is noise, not diagnosis.
wake_notified() {
  local kind="$1" key="$2"
  wake_init
  [[ -e "$WAKE_ROOT/notified/$(wake_slug "${kind}-${key}")" ]]
}

# Clear the once-only marker so the condition can notify again.
wake_reset_once() {
  local kind="$1" key="$2"
  rm -f "$WAKE_ROOT/notified/$(wake_slug "${kind}-${key}")" 2>/dev/null || true
}

# Count of unread wakes.
wake_pending_count() {
  wake_init
  find "$WAKE_PENDING" -maxdepth 1 -name '*.json' -type f 2>/dev/null | wc -l | tr -d ' '
}
