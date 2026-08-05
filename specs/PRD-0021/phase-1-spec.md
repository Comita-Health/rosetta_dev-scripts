---
id: SPEC-PRD-0021-P1
prd: PRD-0021
phase: 1
status: Approved # Draft | Approved | Done | Superseded
date: 2026-08-04
owner: Russ Watson
envelope:
  allowedPaths: ['sdlc-workflow/**', 'CHANGELOG.md']
  forbiddenSurfaces: ['ci-config', 'personal-queue-schema']
  maxDiffLines: 2500
  budgetK: 200
---

# SPEC-PRD-0021-P1: Phase 1 of PRD-0021 makes the run engine crash-safe: state.json becomes atomically written and single-writer-locked, a shared bounded retry executor with capped backoff absorbs transient non-gate step failures (PR open, sandbox deploy, Chronicle commit) with resumption from the step cache instead of hand-edits, and retried agent dispatches run with a sanitized environment so they can never silently no-op from inherited nested-agent flags.

## Context

Today a crash mid-write, a relaunch racing a manual resume, or a failed non-gate step can each halt a run overnight and require manual state.json surgery. This phase is scoped to the PRD's rollout Phase 1 — crash-safe state plus step retry policy — and lands the durability primitive first (atomic, lock-guarded state.json writes, S-04), then a single shared bounded-retry executor on top of it (S-01), then the two consumers this phase permits: non-gate step retries with step-cache resume, and environment sanitation for retry-dispatched agents. The executor is deliberately built as the one retry-policy surface that later phases (gate/flaky-verification retries in Phase 2; verdict invalidation and circuit breakers in Phases 2–3) will also consume, so the attempt cap, backoff, and recovery-history schema are defined exactly once — but those consumers do not land here. Every path through the executor must enforce a terminal attempt cap and must never fabricate, soften, or mutate a verdict.

## Task T-01: Atomic tmp-file-plus-rename writes for state.json

- **Story:** S-04
- **Complexity:** M
- **Depends on:** []

Every recovery mechanism in this phase depends on state.json surviving a crash mid-write. Write to a temp file in the same directory, fsync, then rename over the target so the previous valid state is always intact on failure. No partial or torn writes may ever be observable by a reader.

### Acceptance criteria

- [x] test: state.json writes go through a temp-file-plus-rename sequence rather than an in-place write.
- [x] test: a simulated crash/kill during the write step leaves the previous valid state.json fully intact and parseable on the next read.
- [x] test: a reader polling state.json during a concurrent write never observes a partially written or truncated file.

## Task T-02: Single-writer run lock for state.json

- **Story:** S-04
- **Complexity:** M
- **Depends on:** [T-01]

Lock acquisition must make the relaunch-vs-manual-resume race structurally impossible, not merely unlikely by convention. A second writer must fail fast with a clear, actionable error rather than blocking indefinitely or clobbering state.

### Acceptance criteria

- [x] test: acquiring the run lock while it is already held by another writer fails fast with a distinct, clearly identifiable error.
- [x] test: state.json writes are rejected unless the caller currently holds the run lock.
- [x] test: a simulated continuity-layer relaunch and a simulated manual resume racing for the lock result in exactly one winner and one fast failure, never a double-write.

## Task T-03: Shared bounded retry executor with attempt cap and recovery history

- **Story:** S-01
- **Complexity:** L
- **Depends on:** [T-02]

This is the single retry-policy surface for the engine: attempt cap, backoff, and the recovery-history record schema are defined here exactly once. In this phase only the non-gate step retry path (T-04) consumes it; the interface must be generic enough for later phases' gate-retry and breaker-resume consumers without rework. The executor re-invokes the caller-supplied step callback only; it must have no code path that can construct or mutate a verdict itself.

### Acceptance criteria

- [x] test: the executor enforces a configurable terminal attempt cap per recovery path; once exhausted it invokes escalation exactly once and never loops further.
- [x] test: the executor applies backoff between attempts and appends each attempt's timestamp, action, and outcome to a recovery-history structure returned to the caller.
- [x] test: the executor only re-invokes the supplied step callback and never itself constructs, mutates, or overrides a verdict object.

## Task T-04: Non-gate step retry with backoff and step-cache resume

- **Story:** S-01
- **Complexity:** M
- **Depends on:** [T-03]

Applies to PR-open, sandbox-deploy, and Chronicle-commit steps specifically, driven through the T-03 executor. Resumption must read from the step cache already present in state.json under the T-02 lock; no manual state.json edits are permitted or required.

### Acceptance criteria

- [x] test: a failed non-gate step (PR open, sandbox deploy, Chronicle commit) is retried with backoff up to policy using the shared retry executor.
- [x] test: after a non-gate step retry succeeds, the run resumes from the step cache in state.json with zero hand-edits.
- [ ] agent: resuming a retried non-gate step through the running interface produces no duplicate side effect (e.g. no duplicate PR) compared to the original failed attempt.

## Task T-05: Sanitized dispatch environment for retried agents

- **Story:** S-01
- **Complexity:** S
- **Depends on:** [T-04]

Strip or override CURSOR_AGENT (and equivalent inherited flags) before spawning any nested implementation/fix agent during a retry, so a retry can never silently inherit a no-op mode from the outer orchestrator process.

### Acceptance criteria

- [x] test: agents dispatched during a retry run with CURSOR_AGENT (and equivalent inherited flags) unset or overridden, even when the outer orchestrator process has it set.
- [ ] agent: a retry-dispatched agent observed through the running interface performs real work rather than silently no-oping due to an inherited nested-agent flag.
