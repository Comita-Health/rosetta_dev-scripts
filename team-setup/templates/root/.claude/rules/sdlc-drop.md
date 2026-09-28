# SDLC drop (default for inbox work)

When the ask is a GitHub issue (or a small set of issues) that should
land as **one PR**, or the user asks to drop / `/sdlc-drop`:

- Follow the **`sdlc-drop`** skill.
- Arm `sdlc-workflow drop --drop-id … --repo … --issues owner/repo#N`.
- Implement as commits in `~/.rosetta/sdlc-drops/<id>/worktree`.
- `drop --finish` opens the one PR; then arm **`pr-approve-watch`**
  and **`pr-checks-watch`**.
- **Every drop is smoked on the sandbox before Approve.** `--finish`
  prints how: when the repo declares `sandbox.dropDeployWorkflow` in
  `.sdlc/environments.json`, the repo deploys the PR on every push and
  posts the result on the PR. Otherwise arm **`deploy-verify-watch`**
  with `--dispatch-on-arm` right after `--finish`. Either way arm the
  watcher so `deploy_green` wakes you; it only watches when the repo
  deploys itself.
- Do **not** `decompose` a drop into per-task PRs.
- Same-session related work on a **one-SHA smoke host** is **one
  bundle** (one branch, many commits, one PR). Do not steal the host
  with sibling drops from the default branch — see
  **`sdlc-live-host-bundle`**.
- `run` / `decompose` stay the spec-task opt-in for an Accepted
  multi-task spec — see `sdlc-run-supervise`.
- `--finish` does **not** wait on reviewer, CI, or AC. For `direct` it
  then calls `gh pr merge`. Foundation `main` today requires status
  checks only — not approving reviews — so that merge succeeds. Pass
  **`--require-approve`** when Approve / GHA merge-on-approve must stay
  the proceed signal. `BRANCH_PROTECTION_REQUIRES_HUMAN` only fires
  when protection actually requires a person.
