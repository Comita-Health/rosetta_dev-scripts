---
id: SPEC-BUG-one-click-spec-approval-P1
prd: BUG-one-click-spec-approval # synthetic id — lightweight bug path, no PRD file
phase: 1
status: Draft # Draft | Approved | Done | Superseded
date: 2026-08-04
owner: Russ Watson
envelope:
  allowedPaths:
    [
      '.github/workflows/addi-merge-on-approve.yml',
      'team-setup/scripts/**',
      'team-setup/docs/**',
      'specs/BUG-one-click-spec-approval/**',
      'CHANGELOG.md'
    ]
  forbiddenSurfaces: ['personal-queue-schema']
  maxDiffLines: 300
  budgetK: 100
---

# SPEC-BUG-one-click-spec-approval-P1: One GitHub Approve owns the spec Draft → Approved flip and run launch

## Context

**Symptom:** After a human Approves the PR whose sole purpose is creating an
implementation spec, the machinery still asks the operator to (1) hand-edit
`status: Draft → Approved` in a dedicated commit, (2) push it, and (3) say
"proceed" in chat before `sdlc-workflow run` will start. Three actions where
one was promised — and the first one moves backwards (editing a file the
operator just approved).

**Repro:** Open any spec PR (e.g. a `specs/BUG-*/phase-1-spec.md` with
`status: Draft`), Approve it, let Addi merge-on-approve merge it. Then invoke
`sdlc-workflow run --spec <path> …`: enforce intake refuses with
`spec is not Approved` until a human pushes the status flip.

**Root cause:** No machinery converts the GitHub Approve into the
`Draft → Approved` mechanics. The engine's enforce intake (correctly)
requires `status: Approved` on `origin/<default>`, and the gold-standard
`addi-merge-on-approve.yml` merges approved Addi PRs — but nothing between
them owns the flip, and nothing signals a run launch after the merge.

**Why now / blast radius:** This is the human gate with the wrong shape —
the highest-frequency babysitting seam in the gap analysis (W2). The fix
deliberately edits `.github/workflows/addi-merge-on-approve.yml`, which is
`ci-config` surface: this envelope intentionally omits `ci-config` from
`forbiddenSurfaces` and names the exact workflow file in `allowedPaths` so
the human approving this spec is explicitly approving a CI-workflow change.
No other workflow file may be touched.

## Task T-01: Flip `status: Draft → Approved` on Approve, before merge

- **Story:** S-01
- **Complexity:** S
- **Depends on:** []

Extend the merge-on-approve path: when the Approved, mergeable Addi PR's diff
contains one or more `specs/**/phase-*-spec.md` files whose head-blob
front-matter says `status: Draft`, push a flip commit to the PR branch (as
the org Addi App, DCO signed, conventional message, e.g.
`docs(spec): approve SPEC-… on human Approve`) rewriting only the `status:`
front-matter line, then proceed with the existing merge flow. The flip logic
lives in a standalone script under `team-setup/scripts/` (unit-testable;
the workflow only invokes it). Non-spec PRs must take the existing path
byte-identically.

### Acceptance criteria

- [ ] test: given a spec file with `status: Draft # Draft | Approved | …`,
      the flip script rewrites only the status value (comment and all other
      lines byte-identical) and is idempotent on an already-`Approved` file.
- [ ] test: PR file lists without `specs/**/phase-*-spec.md` entries produce
      no flip commit and no workflow behavior change.
- [ ] agent: on a disposable canary spec PR in this repo, a single human
      Approve results in a flip commit authored by Addi followed by the
      merge — zero further human actions, zero chat prompts.

## Task T-02: Emit a run-launch signal after a spec PR merges

- **Story:** S-01
- **Complexity:** S
- **Depends on:** [T-01]

After merge-on-approve merges a PR that contains spec files, emit
`repository_dispatch` type `sdlc-run-launch` with
`client_payload: { specPaths: string[], mergedSha: string, prNumber: number }`.
Consumers: the PRD-0020 event daemon (watch kind `workflow-run` /
`issue-state`) launches `sdlc-workflow run` for the approved spec; until the
daemon ships, the launch record is also visible to operators via
`gh api /repos/{owner}/{repo}/dispatches` consumers and documented for the
continuity daemon's poll loop. The signal must be emitted exactly once per
merged spec PR (dedup by merge SHA).

### Acceptance criteria

- [ ] test: dispatch payload construction includes every spec path in the
      merged diff and the merge SHA; non-spec merges emit nothing.
- [ ] docs: `team-setup/docs/addi-pr-automation-standard.md` decision table
      and trigger list document the spec-flip step and the `sdlc-run-launch`
      dispatch contract (payload schema, exactly-once semantics, intended
      consumer).
- [ ] agent: diff is confined to the flip/signal feature and its tests — no
      unrelated workflow refactoring.

## Out of scope

- The daemon-side consumer that turns `sdlc-run-launch` into a running
  `sdlc-workflow run` (PRD-0020 Phase 1/3).
- Changing enforce intake's `status: Approved` requirement (correct as-is).
- Distributing the workflow change to consumer orgs' repos (team-setup sync
  is the existing mechanism; Comita adoption is a consumer-side act).
