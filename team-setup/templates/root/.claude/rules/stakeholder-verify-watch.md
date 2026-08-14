# Stakeholder verify watch (Bret / Slack)

When a user-facing sandbox drop is on a live host (or the user asks to
watch stakeholder verify):

- Follow the **`stakeholder-verify-watch`** skill.
- Upsert **Not verified** lines from `docs/releases/YYYY-MM-DD.md` to the
  Slack **Sandbox verify** list (not the Feedback tracker).
- Arm `.cursor/skills/stakeholder-verify-watch/scripts/watch-stakeholder-verify.sh`
  in the background with agent wake on `AGENT_LOOP_WAKE_stakeholder_verify`.
- On **Verified**: move the git line to **Verified**; never delete it.
- On **Failed**: fix / push / republish as Not verified; do not promote.
- Bret has no GitHub. Do **not** ask Russ to relay check-offs.
- Slack Verified is **not** GitHub Approve (`pr-approve-watch`).
- **Chat `notify_on_output` is best-effort.** Drain
  `AGENT_LOOP_WAKE_stakeholder_verify` from the watcher terminal even when
  the chat stays quiet.
