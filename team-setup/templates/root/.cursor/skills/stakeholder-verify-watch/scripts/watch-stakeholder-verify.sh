#!/usr/bin/env bash
# Watch Slack Sandbox verify for Verified / Failed, then emit an agent wake.
#
# Usage:
#   eval "$(bash ~/.config/comita/slack-activate.sh)"
#   bash …/watch-stakeholder-verify.sh [--interval 30] [--kickoff]
#
# Sentinel (stdout): AGENT_LOOP_WAKE_stakeholder_verify <json>
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
exec python3 "$ROOT/verify_slack.py" watch "$@"
