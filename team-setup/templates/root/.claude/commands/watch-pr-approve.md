Arm a background watcher for human GitHub **Approve** or **Request changes** on
one or more PRs (`owner/repo#N`). Wake JSON includes `signal`: `approved` or
`changes_requested`. On Approve: triage review comments (reply + resolve),
merge, and continue. On Request changes: fix path — do not merge. Follow the
`pr-approve-watch` skill (`.claude/skills/pr-approve-watch/SKILL.md` or
`.cursor/skills/pr-approve-watch/SKILL.md`). Pass PR refs from the user or
from PRs you just opened.
