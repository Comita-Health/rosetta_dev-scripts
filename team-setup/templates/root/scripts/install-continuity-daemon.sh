#!/usr/bin/env bash
# Retired (SPEC-PRD-0020-P2 T-05).
#
# Do not install com.rosetta.sdlc-daemon (StartInterval). Use
# `sdlc-workflow daemon install` for the per-workspace KeepAlive agent.
# Remaining session-mortal deploy-verify-watch / issue-resolve-watch scripts
# stay until Phase 3.
set -euo pipefail

cat >&2 <<'EOF'
install-continuity-daemon.sh has been retired (SPEC-PRD-0020-P2 T-05).

It no longer writes or loads a StartInterval LaunchAgent.

Migrate to the per-workspace KeepAlive daemon:

  cd sdlc-workflow
  bun run build
  node dist/index.js daemon install --workspace <workspace-root>

To unload a leftover legacy agent without installing:

  node dist/index.js daemon uninstall --workspace <workspace-root>
  # install/uninstall both unload/remove com.rosetta.sdlc-daemon first

Or:

  bun run --cwd sdlc-workflow dev -- daemon install --workspace <workspace-root>
EOF
exit 1
