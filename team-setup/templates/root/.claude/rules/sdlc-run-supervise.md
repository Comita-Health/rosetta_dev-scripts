# SDLC run supervision (default)

When starting, resuming, or watching `sdlc-workflow` (`run`, shadow waves,
`record-merge` follow-ups):

- Follow the **`sdlc-run-supervise`** skill.
- Detach with OS **`nohup`** and **`--heartbeat`** (see #38 / #39).
- **Do not** block the agent turn on multi-minute poll/`sleep` loops while
  waiting for sandbox, CI, or implementation agents.
- After launch: confirm alive + first heartbeat, report once, yield; check in
  later via `/loop` or heartbeat/log wakes.
- Only interrupt the human for merges, envelope hand-edits, real regressions,
  or wave complete.

Design note: `rosetta_dev-scripts/sdlc-workflow/docs/operator-background-supervise.md`.
