---
name: stakeholder-verify-watch
description: >-
  Publish a sandbox drop’s verify list to Slack (Bret’s check-off ledger).
  Slack Status is the live ledger; do not poll Slack from a laptop. Use
  after a live deploy, or when the user asks to publish stakeholder verify.
---

# Stakeholder verify (Bret / Slack)

**Bret does not have GitHub.** Chronicle is engineering memory; his analog
is the Slack **Sandbox verify** list. He checks **Verified** or **Failed**
there. Slack Status is the live check-off. Git `docs/releases/` is written
at **publish** and snapshotted again at **promote**. Do **not** arm a
laptop Slack poller.

Do **not** use Bret’s **Feedback** tracker for this — that list is an
inbox of asks, not a smoke ledger.

Policy: `comita_docs/docs/runbooks/work-intake-and-verification.md`.

## When to publish

- After a user-facing sandbox deploy is green (or will be by the time he
  starts).
- When opening / pushing a `verify-live` PR that needs Bret smoke.
- When the operator says to publish stakeholder verify.

Pair with `deploy-verify-watch` and `pr-approve-watch`. Slack Verified is
**not** GitHub Approve and is **not** promote-to-prod.

## Hard rules

1. PHI-free rows only (no patient names, filenames that could be PHI,
   production dumps).
2. Upsert by Item text + Host — do not duplicate rows for the same smoke
   line on the same host.
3. **Do not** start `watch-stakeholder-verify.sh` or any local Slack poll
   loop. Failed rows are commented onto the Ship issue by GitHub Action
   `Sandbox verify` (`comita_admissions/.github/workflows/sandbox-verify.yml`).
4. On **Verified**: do nothing in git. Slack already holds it. Promote
   snapshots checkboxes into `docs/releases/`.
5. On **Failed** (from the Ship issue comment): do **not** mark Verified;
   fix / push / republish the row as Not verified. Do not promote.
6. Do not mark Slack Feedback rows Done until the matching verify item is
   Verified on Slack.

## Publish

```bash
eval "$(bash ~/.config/comita/slack-activate.sh)"
# COMITA_VERIFY_SLACK_LIST_ID must be in slack.env (create the list once)

bash .cursor/skills/stakeholder-verify-watch/scripts/publish-stakeholder-verify.sh \
  --file comita_admissions/docs/releases/2026-08-13.md \
  --ship 474
```

Publish upserts **Not verified** rows, then posts `<!channel>` in
**#comita-support** with the list URL and the new smoke lines. Override
the channel with `COMITA_VERIFY_NOTIFY_CHANNEL_ID`. Do not paste the
whole dated markdown into chat. Re-publish is idempotent — already
present rows do not ping again.

If `COMITA_VERIFY_SLACK_LIST_ID` is unset, publish prints the rows and
exits 2. The list is **Sandbox verify** (not Feedback). After create,
put `COMITA_VERIFY_SLACK_LIST_ID` and `COMITA_VERIFY_COL_*` (column ids,
not display names) in `~/.config/comita/slack.env` **and** the matching
GitHub Actions variables on `comita_admissions`. Do not fall back to
pasting a giant checklist in chat.

## Live status (no watch loop)

```bash
python3 comita_admissions/scripts/sandbox-verify/verify_slack.py status
```

Failed notify and promote snapshot are hosted: workflow `Sandbox verify`.
