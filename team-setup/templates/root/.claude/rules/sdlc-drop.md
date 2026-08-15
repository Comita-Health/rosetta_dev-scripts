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
- `--finish` does **not** wait on reviewer, CI, or AC. For `direct` it
  then calls `gh pr merge`. Foundation `main` today requires status
  checks only — not approving reviews — so that merge succeeds. Pass
  **`--require-approve`** when Approve / GHA merge-on-approve must stay
  the proceed signal. `BRANCH_PROTECTION_REQUIRES_HUMAN` only fires
  when protection actually requires a person.
