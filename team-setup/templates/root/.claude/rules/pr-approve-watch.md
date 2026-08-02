# PR Approve watch (default)

When you open a pull request that needs a human proceed signal (especially
Addi / bot-authored PRs), or the user asks you to watch for approval:

- Follow the **`pr-approve-watch`** skill.
- Arm `.cursor/skills/pr-approve-watch/scripts/watch-pr-approve.sh` in the background with agent wake on
  `AGENT_LOOP_WAKE_pr_approve` (fires on Approve **or** Request changes).
- On wake: read `signal`. On **Request changes**: fix/push/reply — **never
  merge**. On **Approve**: triage review comments; if the repo has **Addi
  merge on Approve** enabled (`ADDI_MERGE_ON_APPROVE=true`), **do not merge**
  — GHA merges as Addi. Otherwise verify green checks, merge as Addi (merge
  commit for stacks), pull the default branch, report.
- Do **not** treat chat "approved" as the proceed signal when a GitHub Approve
  path exists.
- Do **not** merge on Approve alone while unaddressed review comments remain.
- **Chat `notify_on_output` is best-effort.** Drain
  `AGENT_LOOP_WAKE_pr_approve` lines from the watcher terminal even when the
  chat stays quiet; treat user “I approved” / “check watchers” as a nudge to
  drain wakes immediately.
