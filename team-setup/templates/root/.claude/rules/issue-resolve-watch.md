# Issue resolve watch (default for owned issues)

When Addi (or the agent) takes ownership of a GitHub issue, or the user asks
to watch an issue:

- Follow the **`issue-resolve-watch`** skill.
- Arm the background watcher (`--kickoff` when work should start now).
- **Drive toward resolution** (Done-when → close). Do not park watched issues.
- On wake: comment/progress/PRs; note blockers on the issue if stuck.
