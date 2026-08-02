---
name: pr-approve-watch
description: >-
  Background-watch Addi-authored (or other agent) PRs for a human GitHub
  Approve proceed signal, then wake the agent to merge and continue. Use when
  opening PRs that await human Approve, or when the user asks to watch for
  approval / proceed-on-approve.
---

# PR Approve watch (proceed signal)

**Proceed signal for agent work is GitHub PR Approve** — not chat "approved".
When you open a PR that needs a human proceed (especially Addi / bot-authored
PRs), arm this watcher so Approve can be acted on without a chat nudge.

## Hard rules

1. After `gh pr create` (or when the user asks to watch), start
   `scripts/watch-pr-approve.sh` in the **background** with agent
   `notify_on_output` on `^AGENT_LOOP_WAKE_pr_approve`.
2. Do **not** redirect the watcher stdout away from the monitored terminal
   (or the wake sentinel will be swallowed).
3. On wake: activate the workspace GitHub App, verify APPROVED + green checks,
   merge, pull `main`, report. If multiple targets remain, leave the watcher
   running (it exits only when all targets have fired).
4. Prefer human (non-bot) Approve. The script uses `reviewDecision == APPROVED`
   when present, else any non-bot `APPROVED` review.

## Launch template

```bash
# From workspace root (paths work after team-setup update-config)
bash .cursor/skills/pr-approve-watch/scripts/watch-pr-approve.sh --interval 30 \
  Owner/repo#123 \
  Owner/other#456
```

Optional: `--activate ~/.config/rosetta/github-app-activate.sh` (Rosetta) or
`~/.config/comita/github-app-activate.sh` (Comita). If omitted, the script
picks from cwd / `ROSETTA_GH_ACTIVATE` / those defaults, else ambient `gh` auth.

Cursor agent loop: background the command with
`notify_on_output` pattern `^AGENT_LOOP_WAKE_pr_approve`.

## On wake

1. `eval "$(bash ~/.config/<rosetta|comita>/github-app-activate.sh)"` when present.
2. `gh pr view <n> -R <owner/repo> --json state,reviewDecision,statusCheckRollup,mergeable`.
3. Merge when checks are green (`gh pr merge` — use the repo's normal merge
   method; stacked PRs need merge commits, never squash-merge a stack).
4. `git checkout main && git pull --ff-only` in the affected local clone.
5. Brief report with the merged PR URL.

## Anti-patterns

- Blocking the chat with a foreground `sleep`/poll loop waiting for Approve.
- Treating chat "LGTM" / "approved" as the proceed signal when an Addi PR exists.
- Redirecting watcher stdout to a file without `tee` (breaks wake notifications).
