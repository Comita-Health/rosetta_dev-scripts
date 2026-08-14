#!/usr/bin/env bash
# Local Slack pollers are retired. Slack is the live ledger; GHA comments
# Failed rows onto the Ship issue. Git snapshots at promote.
echo "sandbox-verify: local Slack watch is retired." >&2
echo "Live ledger: Slack Sandbox verify." >&2
echo "Failed rows: GitHub Action 'Sandbox verify' on comita_admissions." >&2
echo "Git snapshot: promote-to-prod / workflow_dispatch action=snapshot." >&2
exit 2
