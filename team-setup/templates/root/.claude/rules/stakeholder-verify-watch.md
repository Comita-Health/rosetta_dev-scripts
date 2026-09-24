---
description: "Default: publish sandbox verify to a Slack thread; do not poll Slack from a laptop"
alwaysApply: true
---

# Stakeholder verify (Bret / Slack)

When a user-facing sandbox drop is on a live host (or the user asks to
publish stakeholder verify):

- Follow the **`stakeholder-verify-watch`** skill.
- Each drop is **one thread** in **#comita-support**: a root message
  (`@channel`, release date, ship, host, SHA) plus one reply per
  **Not verified** line from `docs/releases/YYYY-MM-DD.md`. Bret reacts
  :white_check_mark: verified / :x: failed. Only the root pings.
- Publish **only after** the sandbox deploy for that SHA is green.
- **Do not** arm a local Slack poller. Slack is the live ledger. Failed
  rows are commented onto the Ship issue by GHA **Sandbox verify**.
  Promote snapshots verified lines into git.
- On :x: (issue comment): fix / push / redeploy; do not promote.
- Bret has no GitHub. Do **not** ask Russ to relay check-offs.
- A :white_check_mark: is **not** GitHub Approve (`pr-approve-watch`).
- When the operator **linked a Slack thread** as the ask, SB deploy
  green also gets a **thread reply** on that message (see
  `deploy-verify-watch`). That is not this thread and not `@channel`.

The paid Slack **Lists** model is retired — do not reintroduce
`slackLists.*` calls, `COMITA_VERIFY_SLACK_LIST_ID`, or
`COMITA_VERIFY_COL_*`.
