# SDLC live-host bundle (one smoke SHA)

A **live smoke host** (Deploy Organization / dest `admit.dev` / SB) serves
**one SHA**. Each PR deploy replaces the host. Sibling drops from the
default branch steal the host — yesterday’s **i** button, today’s catalog
editor, never both.

When the asks are the **same session, same product surface, same host**:

1. Name **one** drop (`admissions-2026-08-19-run-comita`).
2. Arm **once** from the default branch (`main` or `build-env/dev`).
3. Every follow-up is a **commit on that branch**. New issue, same
   worktree. Do **not** `--finish` after the first ping.
4. **One PR** when the bundle is what you want smoked. `Closes #A #B #C`.
5. Deploy **that** head only. One Approve. GHA merges once when enabled.

**Do not** open five PRs from dest tip and later squash them into a
mega-PR. **Do not** deploy the middle of a stack — the tip *is* the
bundle.

**Unrelated work** (billing, another app, a hotfix that must land
alone) still branches from the default branch. Do not chain it onto
the bundle.

**Stacked PRs** (child `--base` parent) stay valid when you need
per-issue review *and* a tip that has everything: merge bottom-up
with **merge commits**, never squash, deploy only the tip. That is
not a sixth “bundle PR.”

Follow **`sdlc-drop`**. Re-arming the same `--drop-id` reuses the
worktree — that is the bundle.
