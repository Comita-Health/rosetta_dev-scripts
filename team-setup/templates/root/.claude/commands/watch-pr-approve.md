Arm a background watcher for human GitHub Approve on one or more PRs
(`owner/repo#N`), then on wake: triage review comments (reply + resolve). If
the repo enables Addi merge on Approve, do **not** merge from the agent — GHA
owns merge. Otherwise merge and continue. Follow the `pr-approve-watch` skill
(`.claude/skills/pr-approve-watch/SKILL.md` or
`.cursor/skills/pr-approve-watch/SKILL.md`). Pass PR refs from the user or
from PRs you just opened.

Note: chat wake notify is best-effort — drain `AGENT_LOOP_WAKE_pr_approve`
from the watcher terminal if the chat stays quiet after Approve.
