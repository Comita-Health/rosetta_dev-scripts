---
id: SPEC-PRD-0022-P1
prd: PRD-0022
phase: 1
status: Approved # Draft | Approved | Done | Superseded
date: 2026-08-04
owner: Russ Watson
envelope:
  allowedPaths: ['sdlc-workflow/**', '.sdlc/**', 'CHANGELOG.md']
  forbiddenSurfaces: ['ci-config', 'personal-queue-schema']
  maxDiffLines: 1500
  budgetK: 200
---

# SPEC-PRD-0022-P1: Phase 1 of PRD-0022 eliminates redundant and racing sandbox deploys: every dispatched deploy is recorded as a run artifact keyed by tree-content SHA, the merge path reuses a matching PR-head deploy instead of re-deploying identical content, phase-boundary dispatch checks for an in-flight or completed push-triggered deploy before firing, and the whole path — including SPEC-PRD-0011-P4's path-aware fast-pass — is validated in a live run rather than only in mocked tests.

## Context

This phase is scoped to the PRD's rollout Phase 1 — path-aware deploy landed plus deploy dedup. Its prerequisite is the pre-existing `SPEC-PRD-0011-P4` (path-aware "deploy landed" fast-pass), which must land first; this phase completes and live-validates that behavior and removes the two sources of wasted or racing deploy spend observed in live runs: the merge path re-deploying content identical to an already-deployed PR head (a merge commit SHA differs from its PR-head SHA even when the tree is identical, so dedup must key on tree content), and phase-boundary dispatch racing push-triggered deploys for the same content. Content-level delivery verdicts (contract schema, repo-owned assertion scripts, negative assertions) are Phase 2; run-observability work (heartbeat truthfulness, agentAlive, thrash detection, status/ETA) is Phase 3 — none of that lands here.

## Task T-01: Content-SHA deploy records as run artifacts

- **Story:** S-02
- **Complexity:** M
- **Depends on:** []

Record every dispatched deploy as a durable run artifact keyed by the deployed tree-content SHA (not the commit SHA), including the trigger (push, merge, phase-boundary), workflow run reference, and terminal outcome. This is the primitive both dedup (T-02) and race avoidance (T-03) key off; without a durable record of what content is deployed or in flight, neither can make a correct skip decision.

### Acceptance criteria

- [ ] test: dispatching a deploy writes a run artifact containing the tree-content SHA, trigger source, workflow run reference, and outcome.
- [ ] test: two commits with different commit SHAs but identical tree content resolve to the same content-SHA key in the deploy record.
- [ ] test: deploy records survive engine process restart and are readable by run ID after the run completes.

## Task T-02: Merge-path deploy dedup keyed on content SHA

- **Story:** S-02
- **Complexity:** M
- **Depends on:** [T-01]

Dedup must compare tree content via T-01's records, not commit SHA string equality. Reuse decisions must be recorded as run artifacts, not just implied by the absence of a new deploy.

### Acceptance criteria

- [ ] test: when the merged commit's content equals an already-deployed PR-head SHA's content, the merge path records reuse of that deploy instead of dispatching a new one.
- [ ] test: when merged content differs from any previously deployed PR-head SHA, a new deploy is dispatched normally.
- [ ] agent: merge a PR whose head was already deployed and confirm no second deploy job is dispatched, with the reuse decision visible in run artifacts.

## Task T-03: Phase-boundary deploy race avoidance against push-triggered deploys

- **Story:** S-02
- **Complexity:** L
- **Depends on:** [T-01, T-02]

Needs an idempotency/locking guard keyed on content SHA so phase-boundary dispatch checks T-01's records for an in-flight or completed push deploy before firing its own, rather than relying on timing alone.

### Acceptance criteria

- [ ] test: phase-boundary flow checks for an in-flight or completed push-triggered deploy for the same content SHA and skips dispatch if one exists or is pending.
- [ ] test: near-simultaneous triggering of phase-boundary and push deploy for the same SHA results in exactly one dispatched deploy job.
- [ ] agent: trigger a push deploy and a phase boundary for the same SHA in close succession and confirm only one deploy runs end-to-end.

## Task T-04: Live validation of dedup, race avoidance, and PRD-0011 Phase 4 fast-pass

- **Story:** S-02
- **Complexity:** M
- **Depends on:** [T-02, T-03]

This task exists specifically to validate that the fast-pass and dedup behavior hold in a live run, not merely in isolated/mocked tests; it exercises T-01 through T-03 together with the landed `SPEC-PRD-0011-P4` behavior against real infrastructure.

### Acceptance criteria

- [ ] agent: run a docs-only task through the live sandbox contract and confirm it fast-passes in seconds with zero deploy dispatches.
- [ ] agent: run a deployable task through a live run and confirm it ships and health-checks the actual deployed SHA end-to-end, with the deploy recorded under its content SHA.
- [ ] test: an automated live-run smoke check confirms PRD-0011 Phase 4 fast-pass timing and the no-deploy assertion hold true against real (non-mocked) infrastructure.
