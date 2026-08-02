# PR Approve watch (default)

When you open a pull request that needs a human proceed signal (especially
Addi / bot-authored PRs), or the user asks you to watch for approval:

- Follow the **`pr-approve-watch`** skill.
- Arm `scripts/watch-pr-approve.sh` in the background with agent wake on
  `AGENT_LOOP_WAKE_pr_approve`.
- On wake: verify Approve + green checks, **triage review comments** (reply +
  resolve threads; fix before merge if actionable), then merge, pull the
  default branch, report.
- Do **not** treat chat "approved" as the proceed signal when a GitHub Approve
  path exists.
- Do **not** merge on Approve alone while unaddressed review comments remain.
