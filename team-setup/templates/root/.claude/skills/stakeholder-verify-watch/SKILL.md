---
name: stakeholder-verify-watch
description: >-
  Publish a sandbox drop’s verify list to Slack (Bret’s check-off ledger)
  and watch for Verified / Failed so git docs/releases stays in sync
  without Russ relaying. Use after a live deploy, or when the user asks
  to watch stakeholder verify.
---

# Stakeholder verify watch (Bret / Slack)

**Bret does not have GitHub.** Chronicle is engineering memory; his analog
is the Slack **Sandbox verify** list. He checks **Verified** or **Failed**
there. Agents sync `docs/releases/` and do **not** ask Russ to relay.

Do **not** use Bret’s **Feedback** tracker for this — that list is an
inbox of asks, not a smoke ledger.

Policy: `comita_docs/docs/runbooks/work-intake-and-verification.md`.

## When to arm

- After a user-facing sandbox deploy is green (or will be by the time he
  starts).
- When opening / pushing a `verify-live` PR that needs Bret smoke.
- When the operator says to watch stakeholder verify.

Pair with `deploy-verify-watch` and `pr-approve-watch`. Slack Verified is
**not** GitHub Approve.

## Hard rules

1. PHI-free rows only (no patient names, filenames that could be PHI,
   production dumps).
2. Upsert by Item text — do not duplicate rows for the same smoke line.
3. After a live sandbox deploy (or when the user asks), start
   `.cursor/skills/stakeholder-verify-watch/scripts/watch-stakeholder-verify.sh`
   in the **background** with agent `notify_on_output` on
   `^AGENT_LOOP_WAKE_stakeholder_verify` (Claude Code mirror:
   `.claude/skills/stakeholder-verify-watch/scripts/`).
4. On `verified`: move the matching line in `docs/releases/YYYY-MM-DD.md`
   from **Not verified** to **Verified**. Commit as Addi if the operator
   wants git updated in that sitting.
5. On `failed`: do **not** mark Verified; fix / push / republish the row
   as Not verified. Comment the issue.
6. Do not mark Slack Feedback rows Done until the matching verify item is
   Verified.
7. Drain `AGENT_LOOP_WAKE_stakeholder_verify` from the watcher terminal
   even when chat notify is silent.

## Wake delivery (chat notify is best-effort)

`notify_on_output` often does **not** start a new agent turn after the turn
that armed the watcher has ended. The sentinel still prints to the watcher
terminal:

```text
AGENT_LOOP_WAKE_stakeholder_verify {"signal":"verified","item":"...","notes":""}
```

**Agent duties while a watcher is armed:**

- Before ending a turn: skim armed watcher terminal output for unconsumed
  `AGENT_LOOP_WAKE_stakeholder_verify` lines and process each **now**.
- When the user says Bret verified, “check watchers”, “process wakes”, or
  similar: that is a proceed nudge — read the watcher terminal **and** the
  Slack list, then drain any fired or missed wakes.
- Do not claim “no activity” without checking the watcher terminal.

## Publish then watch

```bash
eval "$(bash ~/.config/comita/slack-activate.sh)"
# COMITA_VERIFY_SLACK_LIST_ID must be in slack.env (create the list once)

bash .cursor/skills/stakeholder-verify-watch/scripts/publish-stakeholder-verify.sh \
  --file comita_admissions/docs/releases/2026-08-13.md \
  --ship 474

bash .cursor/skills/stakeholder-verify-watch/scripts/watch-stakeholder-verify.sh \
  --interval 30 \
  --kickoff
```

Arm the watcher in the **background** with agent `notify_on_output` on
`^AGENT_LOOP_WAKE_stakeholder_verify`.

If `COMITA_VERIFY_SLACK_LIST_ID` is unset, publish prints the rows and
exits 2. The list is **Sandbox verify** (not Feedback). After create,
put `COMITA_VERIFY_SLACK_LIST_ID` and `COMITA_VERIFY_COL_*` (column ids,
not display names) in `~/.config/comita/slack.env` so `slack-activate.sh`
exports them. Do not fall back to pasting a giant checklist in chat.

## Wake JSON

```text
AGENT_LOOP_WAKE_stakeholder_verify {"signal":"kickoff","list_id":"..."}
AGENT_LOOP_WAKE_stakeholder_verify {"signal":"verified","item":"...","notes":""}
AGENT_LOOP_WAKE_stakeholder_verify {"signal":"failed","item":"...","notes":"..."}
```

`signal` is `kickoff` | `verified` | `failed`.

## On wake — `signal: verified`

1. Find the matching `- [ ]` line in today’s `docs/releases/` file.
2. Move it to **Verified** as `- [x]` (never delete).
3. Commit as Addi with DCO (`-s`) when the operator wants git updated now.
4. Do not treat this as GitHub Approve or promote-to-prod.

## On wake — `signal: failed`

1. Do **not** move the git line to Verified.
2. Read Notes (PHI-free). Fix, push, republish the row as Not verified.
3. Comment the tracking issue. Keep watching.
