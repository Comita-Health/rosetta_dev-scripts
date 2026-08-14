# Stakeholder verify watch (Bret / Slack)

When a user-facing sandbox drop is on a live host (or the user asks to
publish stakeholder verify):

- Follow the **`stakeholder-verify-watch`** skill.
- Upsert **Not verified** lines from `docs/releases/YYYY-MM-DD.md` to the
  Slack **Sandbox verify** list (not the Feedback tracker). New rows
  `@channel` **#comita-support** with the list URL and smoke lines.
- **Do not** arm a local Slack poller. Slack is the live ledger. Failed
  rows are commented onto the Ship issue by GHA **Sandbox verify**.
  Promote snapshots Verified into git.
- On **Failed** (issue comment): fix / push / republish as Not verified;
  do not promote.
- Bret has no GitHub. Do **not** ask Russ to relay check-offs.
- Slack Verified is **not** GitHub Approve (`pr-approve-watch`).
