#!/usr/bin/env bash
# Retired (SPEC-PRD-0020-P2 T-05).
#
# Continuity (dead-supervisor relaunch, stale-agent kill, abandoned-run
# flagging, blocker-close wake) lives in the per-workspace TypeScript daemon.
# This script no longer ticks and must not be scheduled via StartInterval.
set -euo pipefail

cat >&2 <<'EOF'
sdlc-continuity-daemon.sh has been retired (SPEC-PRD-0020-P2 T-05).

Migrate to the per-workspace KeepAlive daemon:

  cd sdlc-workflow
  bun run build
  node dist/index.js daemon install --workspace <workspace-root>

Or from a checked-out engine tree:

  bun run --cwd sdlc-workflow dev -- daemon install --workspace <workspace-root>

Verify with:

  launchctl print "gui/$(id -u)/sdlc.workflow.daemon.<workspace-id>"
  # expect KeepAlive=true; com.rosetta.sdlc-daemon must not be loaded
EOF
exit 1
