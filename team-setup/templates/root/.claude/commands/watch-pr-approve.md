Arm a background watcher for human GitHub Approve **or** Request changes on
one or more PRs (`owner/repo#N`). On wake: read `signal` in the wake JSON —
triage/fix on `changes_requested` (never merge); on `approved`, triage
comments and merge only if GHA Addi merge-on-approve is not enabled. Follow
the `pr-approve-watch` skill (`.claude/skills/pr-approve-watch/SKILL.md` or
`.cursor/skills/pr-approve-watch/SKILL.md`). Pass PR refs from the user or
from PRs you just opened.

Note: chat wake notify is best-effort — drain `AGENT_LOOP_WAKE_pr_approve`
from the watcher terminal if the chat stays quiet after a review.
