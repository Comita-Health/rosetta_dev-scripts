#!/usr/bin/env bash
set -euo pipefail

# Health interface of the local process sandbox: verifies the staged build
# artifact exists and reports the deployed SHA (which must match
# SDLC_SANDBOX_SHA for the sandbox gate to pass).

SANDBOX_DIR="${SDLC_SANDBOX_DIR:-$HOME/.rosetta/sandbox/rosetta_dev-scripts}"

test -f "$SANDBOX_DIR/dist/index.js"
sha="$(cat "$SANDBOX_DIR/deployed-sha")"

echo "healthy sha=$sha artifact=$SANDBOX_DIR/dist/index.js"
