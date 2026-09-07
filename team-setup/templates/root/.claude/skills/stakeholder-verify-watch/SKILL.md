---
name: stakeholder-verify-watch
description: >-
  Publish a sandbox drop’s smoke lines to a Slack thread (Bret’s check-off
  ledger). Reactions on that thread are the live ledger; do not poll Slack
  from a laptop. Use after a live deploy, or when the user asks to publish
  stakeholder verify.
---

# Stakeholder verify (Bret / Slack)

**Bret does not have GitHub.** Chronicle is engineering memory; his analog
is a Slack thread per drop. Each drop gets **one root message** in
**#comita-support** (`@channel`, release date, ship, host, SHA) and **one
reply per smoke line**. He reacts on the reply:

- :white_check_mark: — verified
- :x: — failed

Those reactions are the live check-off. Git `docs/releases/` is written at
**publish** and snapshotted again at **promote**. Do **not** arm a laptop
Slack poller.

Do **not** use Bret’s **Feedback** tracker for this — that list is an
inbox of asks, not a smoke ledger. Operator-linked Slack threads get a
separate SB-deploy **thread reply** (`deploy-verify-watch`); that is
not this thread and not `@channel`.

This replaced the paid Slack **Lists** model. Do not reintroduce
`slackLists.*` calls or `COMITA_VERIFY_COL_*` columns.

Policy: `comita_docs/docs/runbooks/work-intake-and-verification.md`.

## When to publish

- **Only after** the sandbox deploy for the SHA Bret will smoke is
  **green**. Not on git push, not on CI green, not while queued.
- When opening / pushing a `verify-live` PR that needs Bret smoke.
- When the operator says to publish stakeholder verify.

Pair with `deploy-verify-watch` and `pr-approve-watch`. A
:white_check_mark: is **not** GitHub Approve and is **not**
promote-to-prod.

## Hard rules

1. PHI-free rows only (no patient names, filenames that could be PHI,
   production dumps).
2. One thread per drop, keyed by `sv:<release-stem>:<ship>` in the root
   message. Re-publishing reuses that thread and never re-posts a line
   that is already in it.
3. **Do not** start `watch-stakeholder-verify.sh` or any local Slack poll
   loop. Failed rows are commented onto the Ship issue by GitHub Action
   `Sandbox verify` (`comita_admissions/.github/workflows/sandbox-verify.yml`).
4. On :white_check_mark:: do nothing in git. Slack already holds it.
   Promote snapshots the checkbox into `docs/releases/`.
5. On :x: (from the Ship issue comment): do **not** promote; fix, push,
   redeploy, then ask him to clear the reaction and re-smoke.
6. :x: beats :white_check_mark: on the same reply — a failed re-smoke
   never promotes on a stale check.
7. Do not mark Slack Feedback rows Done until the matching smoke line is
   :white_check_mark: on the thread.

## Publish

Publishing is **hosted** — the `notify-sandbox-landed` job in Deploy
Organization runs it once the sandbox deploy is green. Run it by hand
only to backfill:

```bash
eval "$(bash ~/.config/comita/slack-activate.sh)"

bash .cursor/skills/stakeholder-verify-watch/scripts/publish-stakeholder-verify.sh \
  --file comita_admissions/docs/releases/2026-08-13.md \
  --ship 474
```

Needs `SLACK_BOT_TOKEN`; override the channel with
`COMITA_VERIFY_NOTIFY_CHANNEL_ID`. The bot needs `chat:write`,
`channels:history`, `channels:read` and `reactions:read`.

Only the root message `@channel`s, so a drop pings once no matter how many
smoke lines it has. Do not paste the whole dated markdown into chat.

**Smoke lines come from `## Not verified`** in the dated release note.
H2 and H3 headings both parse; `## Verified` ends the section. A publish
that reports `0 Not-verified line(s)` on a file that clearly has some is a
bug — do not shrug it off, that is how the previous ledger silently died.

## Live status (no watch loop)

```bash
python3 comita_admissions/scripts/sandbox-verify/verify_slack.py status
# or scope to one drop:
python3 .../verify_slack.py status --file docs/releases/2026-08-13.md --ship 474
```

Failed notify and promote snapshot are hosted: workflow `Sandbox verify`.
