#!/usr/bin/env bash
# Thin daemon client: register pr-review watches and exit.
#
# Polling lives in the workspace `sdlc-workflow` daemon. This script only
# registers durable watches (kind=pr-review) and prints `daemon status` so
# the operator can confirm coverage — it does not sleep or poll GitHub.
#
# Usage:
#   bash .cursor/skills/pr-approve-watch/scripts/watch-pr-approve.sh \
#     [--workspace ~/projects/rosetta] \
#     [--interval 30] \
#     [--engine ~/projects/rosetta/rosetta_dev-scripts/sdlc-workflow] \
#     Rosetta-Foundation/rosetta_docs#31 \
#     Rosetta-Foundation/rosetta_dev-scripts#1
#
# Wakes: daemon notify prints AGENT_LOOP_WAKE_pr-review on the daemon log;
# agents also drain via `sdlc-workflow daemon status --json` / the wake inbox.
# Pair with Cursor notify_on_output on ^AGENT_LOOP_WAKE_pr-review when
# watching the daemon log; otherwise poll `daemon status` on check-in.
set -euo pipefail

INTERVAL=""
WORKSPACE="${ROSETTA_WORKSPACE:-}"
ENGINE="${SDLC_WORKFLOW_ENGINE:-}"
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
    --workspace)
      WORKSPACE="${2:?}"
      shift 2
      ;;
    --workspace=*)
      WORKSPACE="${1#*=}"
      shift
      ;;
    --engine)
      ENGINE="${2:?}"
      shift 2
      ;;
    --engine=*)
      ENGINE="${1#*=}"
      shift
      ;;
    --activate|--activate=*)
      # Daemon auth comes from .sdlc/daemon.json activateScript; ignore legacy flag.
      if [[ "$1" == --activate ]]; then
        shift 2
      else
        shift
      fi
      ;;
    -h|--help)
      sed -n '2,22p' "$0"
      exit 0
      ;;
    *)
      TARGETS+=("$1")
      shift
      ;;
  esac
done

if [[ ${#TARGETS[@]} -eq 0 ]]; then
  echo "usage: $0 [--workspace PATH] [--interval SECONDS] [--engine PATH] owner/repo#N [...]" >&2
  exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Installed layout: <workspace>/.cursor|claude/skills/pr-approve-watch/scripts/
resolve_workspace() {
  if [[ -n "$WORKSPACE" ]]; then
    printf '%s' "$WORKSPACE"
    return
  fi
  if [[ -n "${ROSETTA_WORKSPACE:-}" ]]; then
    printf '%s' "$ROSETTA_WORKSPACE"
    return
  fi
  local candidate
  candidate="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
  if [[ -f "${candidate}/.sdlc/daemon.json" || -d "${candidate}/rosetta_dev-scripts" ]]; then
    printf '%s' "$candidate"
    return
  fi
  printf '%s' "$(pwd)"
}

resolve_engine() {
  if [[ -n "$ENGINE" ]]; then
    printf '%s' "$ENGINE"
    return
  fi
  if [[ -n "${SDLC_WORKFLOW_ENGINE:-}" ]]; then
    printf '%s' "$SDLC_WORKFLOW_ENGINE"
    return
  fi
  local ws="$1"
  local candidate
  for candidate in \
    "${ws}/rosetta_dev-scripts/sdlc-workflow" \
    "${SCRIPT_DIR}/../../../../../../sdlc-workflow" \
    "${SCRIPT_DIR}/../../../../../sdlc-workflow"; do
    if [[ -f "${candidate}/src/index.ts" || -f "${candidate}/package.json" ]]; then
      (cd "$candidate" && pwd)
      return
    fi
  done
  if command -v sdlc-workflow >/dev/null 2>&1; then
    printf 'path:sdlc-workflow'
    return
  fi
  printf ''
}

WORKSPACE="$(resolve_workspace)"
ENGINE_PATH="$(resolve_engine "$WORKSPACE")"

if [[ -z "$ENGINE_PATH" ]]; then
  echo "watch-pr-approve: cannot locate sdlc-workflow engine (set --engine or SDLC_WORKFLOW_ENGINE)" >&2
  exit 1
fi

run_daemon() {
  if [[ "$ENGINE_PATH" == path:sdlc-workflow ]]; then
    sdlc-workflow "$@"
  else
    (cd "$ENGINE_PATH" && bunx tsx src/index.ts "$@")
  fi
}

REGISTER_ARGS=(
  daemon watch
  --workspace "$WORKSPACE"
  --kind pr-review
  --created-by pr-approve-watch
)
if [[ -n "$INTERVAL" ]]; then
  REGISTER_ARGS+=(--poll-seconds "$INTERVAL")
fi
REGISTER_ARGS+=("${TARGETS[@]}")

echo "watch-pr-approve: registering pr-review watches for ${TARGETS[*]} (workspace=${WORKSPACE})" >&2
run_daemon "${REGISTER_ARGS[@]}"

echo "watch-pr-approve: daemon status after arm" >&2
run_daemon daemon status --workspace "$WORKSPACE"

echo "watch-pr-approve: armed; polling is the daemon's job — this client exits" >&2
