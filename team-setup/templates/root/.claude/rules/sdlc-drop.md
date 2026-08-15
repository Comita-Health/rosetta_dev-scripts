# SDLC drop (default for inbox work)

When the ask is a GitHub issue (or a small set of issues) that should
land as **one PR**, or the user asks to drop / `/sdlc-drop`:

- Follow the **`sdlc-drop`** skill.
- Arm `sdlc-workflow drop --drop-id … --repo … --issues owner/repo#N`.
- Implement as commits in `~/.rosetta/sdlc-drops/<id>/worktree`.
- `drop --finish` opens the one PR; then arm **`pr-approve-watch`**.
- Do **not** `decompose` a drop into per-task PRs.
- `run` / `decompose` stay the spec-task opt-in for an Accepted
  multi-task spec — see `sdlc-run-supervise`.
- `--finish` does **not** wait on reviewer, CI, or AC. On repos that
  still require a human Approve (including Foundation today), merge
  fails loud (`BRANCH_PROTECTION_REQUIRES_HUMAN`). That is expected
  until Phase 3 protection is installed. Do not claim `--finish`
  already skips Approve.
