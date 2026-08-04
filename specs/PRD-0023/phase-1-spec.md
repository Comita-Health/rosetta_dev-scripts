---
id: SPEC-PRD-0023-P1
prd: PRD-0023
phase: 1
status: Approved # Draft | Approved | Done | Superseded
date: 2026-08-04
owner: Russ Watson
envelope:
  allowedPaths: ['sdlc-workflow/**', 'CHANGELOG.md']
  forbiddenSurfaces: ['ci-config', 'personal-queue-schema']
  maxDiffLines: 2000
  budgetK: 200
---

# SPEC-PRD-0023-P1: Phase 1 of PRD-0023 ("Same-repo closeout") builds the automated closeout pipeline: on an enforce run's final task merge, an idempotent bot-generated PR derives every spec checkbox and the spec's status field solely from recorded verification verdicts, phase-complete reporting is gated on the closeout PR's existence, the closeout PR is linked into the run's Chronicle artifacts, and a regression test pins that spec writes remain exclusive to this path.

## Context

PRD-0023 replaces manual closeout doc-authoring with a verdict-derived, single-writer pipeline. Verification verdicts (per task/gate, with evidence links) already exist as the system's source of truth; this phase adds the aggregation, PR-generation, and digest-gating logic that reads them, plus the guardrails (envelope-gate regression pin, single-caller check) that keep the pipeline the sole and trustworthy source of spec status changes. This phase is scoped to the PRD's rollout Phase 1 — same-repo closeout only. Propagation into the owning PRD's rollout checklist and product records tables (including stacked-PR handling and cross-repo linking) is Phase 2; runbook surfacing is Phase 3 — neither lands here. The closeout PR generator runs as a distinct, already-privileged writer identity; this phase does not change who is allowed to write to specs/**, only proves and pins that non-closeout writers remain blocked.

## Task T-01: Aggregate verification verdicts per task and gate

- **Story:** S-01
- **Complexity:** M
- **Depends on:** []

Build a read-only module that, given a run ID, walks all tasks and collects recorded verification verdicts keyed by (task, gate), including evidence links, then exposes them indexed by spec criterion ID. This is a pure read/aggregation layer over existing verdict records — no new verdict-recording logic. Must return an explicit 'no verdict' state for criteria lacking a recorded verdict rather than omitting them, since downstream checkbox derivation depends on a complete map.

### Acceptance criteria

- [ ] test: given a run with mixed passing/failing/missing verdicts, the aggregator returns one record per (task, gate) with the evidence link populated when present
- [ ] test: criteria with no recorded verdict are returned with an explicit no-verdict state rather than being omitted from the result
- [ ] agent: querying the aggregator against a real enforce run's recorded verdicts reproduces the same pass/fail breakdown visible in the run's existing verdict log

## Task T-02: Trigger and generate closeout PR on final task merge

- **Story:** S-01
- **Complexity:** L
- **Depends on:** [T-01]

Hook into the final-task-merge event of an enforce run. Derive all checkbox state exclusively from T-01's aggregation — no operator input or free-text authoring. PR body cites (task, gate, evidence link) per checked item and lists unchecked criteria under a distinct Remainder section. On re-invocation (e.g., after an interruption), look up an existing open closeout PR by a stable identifier (branch name / PR metadata tag, not title text) and update it in place instead of opening a duplicate.

### Acceptance criteria

- [ ] test: merging a run's final task triggers closeout PR creation with no manual authoring step
- [ ] test: each checkbox with a passing verdict is rendered checked and annotated with its (task, gate, evidence link) citation
- [ ] test: criteria without a passing verdict remain unchecked and appear in a distinct Remainder section of the PR body
- [ ] test: re-invoking closeout generation while an open closeout PR already exists for the run updates that same PR number instead of opening a new one
- [ ] agent: interrupting the closeout job mid-run and re-running it against a real repo leaves exactly one open closeout PR reflecting the latest verdict state

## Task T-03: Roll up spec status field from full verdict coverage

- **Story:** S-02
- **Complexity:** S
- **Depends on:** [T-02]

Extend the closeout generator to compute spec-level status as a pure function of full criteria+phase verdict coverage from T-01. This is the single call site permitted to write status: Done, matching S-05's single-writer requirement. Partial coverage must leave the existing status value untouched — gaps surface only via the Remainder list, never as a downgrade or placeholder.

### Acceptance criteria

- [ ] test: a spec with passing verdicts for every criterion and phase is written as status: Done in the closeout PR diff
- [ ] test: a spec missing any criterion or phase verdict retains its prior status value unchanged in the closeout PR diff
- [ ] test: outstanding criteria/phases for a partially-delivered spec are listed in the remainder section rather than dropped
- [ ] agent: a full-repo search for status: Done write sites shows only the closeout PR generator's call site

## Task T-04: Require closeout PR existence before digest reports phase complete

- **Story:** S-04
- **Complexity:** M
- **Depends on:** [T-02]

Change the phase-completion predicate consumed by the run digest so 'all tasks merged' is necessary but not sufficient — it must also confirm a closeout PR exists for that phase and is merged or open-awaiting-Approve. Query PR state live; do not cache a stale complete flag once tasks merge.

### Acceptance criteria

- [ ] test: a phase with every task merged but no closeout PR is reported incomplete by the digest
- [ ] test: a phase with an open, awaiting-Approve closeout PR is reported complete
- [ ] test: a phase with a merged closeout PR is reported complete
- [ ] agent: running the digest against a live repo where the closeout PR is still in review shows the phase as complete, not stuck

## Task T-05: Link the closeout PR into the run's Chronicle artifacts

- **Story:** S-04
- **Complexity:** S
- **Depends on:** [T-04]

Once T-04 detects a closeout PR exists for a phase, write its URL/reference into that phase's Chronicle artifact record as additive metadata — no other change to the Chronicle artifact schema.

### Acceptance criteria

- [ ] test: once a closeout PR exists for a phase, the Chronicle artifact for that run links to it
- [ ] test: a phase with no closeout PR yet has no closeout link populated in its Chronicle artifact
- [ ] agent: opening the linked URL from a real run's Chronicle artifact navigates to the actual closeout PR

## Task T-06: Pin regression coverage for envelope-gate hard-breach on specs/** edits

- **Story:** S-05
- **Complexity:** S
- **Depends on:** [T-02, T-03]

Coverage-only task: must not alter envelope-gate matching logic, since hard-breach behavior for agent-authored product diffs touching specs/** is required to stay unchanged. Locate the existing issue #40 regression test; restore/unpin it in the mandatory CI suite if it has drifted, and add a static check that the closeout generator's privileged spec-write route (T-02, T-03) has exactly one caller.

### Acceptance criteria

- [ ] test: an agent-authored product diff touching any file under specs/** still hard-breaches the envelope gate exactly as before this phase's changes
- [ ] test: the issue #40 regression test is present, unskipped, and required in the CI suite gating merges
- [ ] test: a static check confirms the closeout PR generator's privileged spec-write route has exactly one caller in the codebase
- [ ] agent: submitting a normal agent task diff that edits a spec file is rejected by the gate before it reaches review
