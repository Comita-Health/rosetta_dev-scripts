---
id: SPEC-BUG-reviewer-house-bar-P1
prd: BUG-reviewer-house-bar # synthetic id — lightweight bug path, no PRD file
phase: 1
status: Approved # Draft | Approved | Done | Superseded
date: 2026-08-04
owner: Russ Watson
envelope:
  allowedPaths:
    [
      'sdlc-workflow/src/**',
      'sdlc-workflow/README.md',
      'specs/BUG-reviewer-house-bar/**',
      'CHANGELOG.md'
    ]
  forbiddenSurfaces: ['ci-config', 'personal-queue-schema']
  maxDiffLines: 500
  budgetK: 150
---

# SPEC-BUG-reviewer-house-bar-P1: The reviewer gate enforces the workspace's own bar

## Context

**Symptom:** A post-run audit found freshly shipped, gate-approved code
systemically non-compliant with rules the workspace treats as
failing-test-equivalent (Handler/Service/Repository shape, inline-docs
requirements). The reviewer gate concurred on every task — its verdicts were
honest against the prompt it was given, but the prompt never mentioned the
mandatory architecture or documentation bar.

**Repro:** Run any task through the reviewer gate in a workspace whose rules
require HSR + TSDoc; submit a diff that adds a service calling another
service with no interface and no docs. The reviewer concurs — nothing in
`reviewer-gate.service.ts`'s prompt construction references the workspace
rules.

**Root cause:** The reviewer prompt is built from diff + task + envelope
only. The workspace's review bar (architecture rules, docs rules) exists as
repo/workspace rule files but is never injected. There is also no
calibration loop: reviewer verdicts are recorded but never linked to
outcomes (veto, rework, post-merge fixes), so there is no evidence base to
tune the gate (PRD-0011 §8 progressive trust).

**Why now / blast radius:** A gate that enforces the wrong bar converts
"reviewer concurrence" into noise, and the gap analysis (W7) commits to
calibrating gates with track record rather than deleting them. Engine-only
change; the checklist _content_ stays workspace-owned (platform boundary —
the engine must not hardcode HSR or any consumer's rules).

## Task T-01: Inject the repo-declared review checklist into the reviewer prompt

- **Story:** S-01
- **Complexity:** S
- **Depends on:** []

Add an optional `.sdlc/review-checklist.md` contract file (target-repo-owned,
like the other `.sdlc/` contracts): a markdown checklist the reviewer must
evaluate the diff against, item by item. When present, the reviewer prompt
includes it and the verdict schema gains per-item findings; when absent,
behavior is unchanged. The engine never ships checklist content — the
Rosetta workspace's HSR/inline-docs checklist lands in each target repo via
team-setup, and consumers declare their own.

### Acceptance criteria

- [x] test: with a checklist present, the reviewer prompt contains its items
      and the parsed verdict carries per-item findings; concur with a failed
      mandatory item is treated as disagree.
- [x] test: with no checklist file, prompt and verdict shapes are
      byte-compatible with current behavior (no regression).
- [x] test: a malformed checklist file fails loud at intake (named error),
      not silently ignored.

## Task T-02: Record verdict outcomes so gate precision is measurable

- **Story:** S-01
- **Complexity:** S
- **Depends on:** []

Link gate verdicts to eventual outcomes in the Chronicle artifacts:
`check-veto`'s revert path and `record-merge` annotate the affected tasks'
existing verdict artifacts (or append a compact outcome record) with
`outcome: vetoed | reworked | stood`, so per-gate precision (how often a
concur preceded a veto/rework, how often a breach was overridden) is
computable from the ledger. Read-side reporting stays out of scope — this
task only guarantees the data exists going forward.

### Acceptance criteria

- [x] test: a veto recorded via `check-veto` appends outcome records
      referencing the phase's task verdicts; `record-merge` marks merged
      tasks' verdicts `stood`.
- [x] test: outcome records are idempotent across resume (no duplicates for
      the same run/task/gate).
- [x] agent: diff confined to verdict/outcome recording and its tests — no
      scoring, thresholds, or gate-behavior changes in this spec.

## Out of scope

- Auto-tuning gate strictness from the recorded precision (future, after a
  track record exists — PRD-0011 §8).
- The reviewer retrigger path and verdict invalidation (PRD-0021
  self-healing run engine).
- Shipping any specific checklist content in the engine (workspace/consumer
  artifact via team-setup).
