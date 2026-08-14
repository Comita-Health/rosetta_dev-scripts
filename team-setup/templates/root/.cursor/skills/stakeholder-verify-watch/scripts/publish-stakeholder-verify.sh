#!/usr/bin/env bash
# Publish Not-verified checkboxes from a dated sandbox release note to Slack.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
exec python3 "$ROOT/verify_slack.py" publish "$@"
