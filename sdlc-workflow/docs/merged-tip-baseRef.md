# Design: post-merge integration tip (#42 + F1)

Live-val finding from a consumer app (`phase-1-spec-2026-08-01`): after
human merges + `record-merge --task`, dependents must **see dependency
code** and gates must measure **only the task's own blast radius**.

## Problem

1. **#42** — Task worktrees were always created from the frozen run
   `baseSha`. After T-01…T-03 merged onto the integration branch, T-04 still
   branched from the Approved-spec SHA, so dependency artifacts were missing
   from the sandbox head.
2. **F1** — Envelope and reviewer still diffed `baseSha...taskBranch`, so
   every prior merged task counted toward `maxDiffLines` (false envelope
   breach) and the reviewer prompt ballooned to a multi-thousand-line mega
   diff (sibling agent sessions crashed when that context was shared).

## Design

Keep `state.baseSha` as the immutable run-start SHA (audit / wave-1 root).

Introduce **`taskIntegrationTip(state, task)`**:

| Task shape      | Tip used for worktree + envelope/reviewer `baseRef`                                   |
| --------------- | ------------------------------------------------------------------------------------- |
| No `dependsOn`  | `state.baseSha`                                                                       |
| All deps merged | `state.mergedSha` (last `record-merge` / auto-merge tip), else last dep's `mergedSha` |

After `record-merge --sha <tip> --task T-xx`:

- Ready dependents branch from that tip (worktree `git worktree add -b … tip`).
- Implementation digest roots at `{task content, tip}` so the T-09 cache
  invalidates if the tip advances.
- Envelope and reviewer evaluate `tip...taskBranch` — a small, task-local
  diff aligned with the GitHub PR vs the integration branch.

## Non-goals

- Rebasing in-flight worktrees created before this fix (operator salvage /
  delete worktree + resume).
- Changing product scope of PRD-0003 or consumer merge policy.
- Replacing human `record-merge` in shadow mode.

## Related

- Umbrella: [rosetta_dev-scripts#43](https://github.com/Rosetta-Foundation/rosetta_dev-scripts/issues/43)
- Defects: #42, F1 on #43
