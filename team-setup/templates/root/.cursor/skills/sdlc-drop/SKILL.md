---
name: sdlc-drop
description: >-
  Default grain for inbox / direct work: one sdlc-workflow drop (one
  worktree + one PR). Arm, implement as commits, drop --finish, then
  pr-approve-watch. Use when the ask is a GitHub issue (or a small set)
  that should land as a single PR. Not for Accepted multi-task specs —
  those still use run / decompose.
---

# SDLC drop — inbox default (one worktree, one PR)

**Default for direct / inbox work.** A named drop is one ship: one
worktree, one branch, one PR. Do **not** `decompose` a drop into
per-task PRs. Tasks are commits (and AC checkboxes on the PR), not
separate reviews.

`run` / `decompose` remain the **spec-task opt-in** for an Accepted
multi-task spec (PRD-0011). See `sdlc-run-supervise`.

Live-val: PRD-0026. Engine: `sdlc-workflow drop`.

## When to use

- A GitHub issue (or a small set) that should land as **one PR**
- Direct, bug-spec, or plan-artifact grain — still one PR
- Parallel ships from the same tip: **two drop ids → two worktrees**

## When not to use

- An Accepted spec with many tasks that should each get a PR → `run`
- Asking the engine to write the commits — `drop` does **not** dispatch
  an implementer agent. You (or this chat) still implement in the
  worktree.

## Hard rules

1. **Arm first** with a durable `--drop-id` and at least one
   `owner/repo#N` issue ref. Re-arming the same id is a no-op (reuses
   the worktree).
2. **Implement only in that worktree.** Do not commit on `main` or on
   an unrelated topic branch.
3. **`--finish` opens one PR.** For `direct` it then calls `gh pr merge`
   unless `--require-approve` is set. It does **not** wait on reviewer,
   CI, or AC checkboxes.
4. **Do not assume `--finish` merge fails on Foundation.** `main` there
   currently requires status checks (`test`, DCO) only — not approving
   reviews — so `gh pr merge` succeeds. That is not Phase 3 protection.
   When the proceed signal must stay human Approve / GHA
   merge-on-approve, pass **`--require-approve`** and arm
   `pr-approve-watch`. `BRANCH_PROTECTION_REQUIRES_HUMAN` only fires
   when protection actually requires a person.
5. If the repo enables **Addi merge on Approve** (`ADDI_MERGE_ON_APPROVE`)
   and you used `--require-approve`, do **not** `gh pr merge` from the
   agent after Approve — GHA merges.
6. If the clone's `origin` is a **fork**, `drop --finish` pushes to
   `origin` and `gh pr create` (no `--repo`) may target the upstream
   parent. Push the drop branch to the canonical remote and create the
   PR with `--repo owner/repo` (and `--head owner:branch` when needed),
   or use a clone whose `origin` is the canonical repo.

## Arm

```bash
ENGINE="<workspace>/rosetta_dev-scripts/sdlc-workflow"
REPO="<absolute-path-to-target-repo>"
DROP_ID="<named-ship-id>"
ISSUE="Owner/repo#N"

cd "$ENGINE"
bunx tsx src/index.ts drop \
  --drop-id "$DROP_ID" \
  --repo "$REPO" \
  --issues "$ISSUE" \
  --base-ref origin/main
# --mode direct|bug-spec|plan-artifact  (default: direct)
# --require-approve  keep human Approve / GHA merge-on-approve
```

Worktree: `~/.rosetta/sdlc-drops/<id>/worktree`  
Branch: `sdlc/drop/<sanitizedId>`

Peek the worktree in the editor. Two ids from the same tip must be
distinct directories.

## Implement

Commits in the drop worktree. Conventional Commits + DCO (`git commit -s`).
Activate the workspace GitHub App so author/committer are Addi.

## Finish

```bash
cd "$ENGINE"
bunx tsx src/index.ts drop \
  --drop-id "$DROP_ID" \
  --repo "$REPO" \
  --issues "$ISSUE" \
  --finish
# add --require-approve when Approve must remain the proceed signal
```

Then arm **`pr-approve-watch`** if the PR is still open. Yield the turn;
do not block the chat waiting for Approve.

## Anti-patterns

- `decompose` of a drop / PRD-0026 into per-task PRs
- Using `run --supervise --detach` for a single inbox issue
- Treating `--finish` as hands-off orchestration (no implementer, no
  CI wait, no AC roll-up)
- Claiming Foundation `--finish` fails loud when protection does not
  require a review
- Implementing in the primary checkout instead of the drop worktree
