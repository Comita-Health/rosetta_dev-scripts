# PR review watch (default)

When you open a pull request that needs a human proceed signal (especially
Addi / bot-authored PRs), or the user asks you to watch for approval / request
changes:

- Follow the **`pr-approve-watch`** skill.
- Arm `scripts/watch-pr-approve.sh` in the background with agent wake on
  `AGENT_LOOP_WAKE_pr_approve`.
- Wake JSON `signal` is `approved` or `changes_requested`.
- On **Approve**: verify green checks, triage review comments (reply + resolve),
  then merge, pull the default branch, report.
- On **Request changes**: triage the review, fix/push/reply — **do not merge**;
  keep watching for Approve or another Request changes.
- Do **not** treat chat feedback as the proceed signal when a GitHub review
  path exists on the PR.
- Do **not** merge on Approve alone while unaddressed review comments remain.
