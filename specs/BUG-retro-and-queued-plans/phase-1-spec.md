---
id: SPEC-BUG-retro-and-queued-plans-P1
prd: BUG-retro-and-queued-plans # synthetic id — lightweight bug path, no PRD file
phase: 1
status: Approved # Draft | Approved | Done | Superseded
date: 2026-08-04
owner: Russ Watson
envelope:
  allowedPaths:
    [
      'sdlc-workflow/src/**',
      'sdlc-workflow/README.md',
      'specs/BUG-retro-and-queued-plans/**',
      'CHANGELOG.md'
    ]
  forbiddenSurfaces: ['ci-config', 'personal-queue-schema']
  maxDiffLines: 700 # raised from 600 (T-02's real non-test diff landed at 626)
  budgetK: 150
---

# SPEC-BUG-retro-and-queued-plans-P1: Bug retros feed intake; approved plans queue without a human relaunch

## Context

**Symptom:** Two process gaps the ideal flow requires and the engine lacks.
(1) Bug runs end at merge: the "why did our process let this through" retro
never happens, so the same regression classes recur (the accounts/admit
`redirect_uri` class bit three times). (2) Planning is parallel but
execution hand-off is manual: when plan B is approved while run A executes,
nothing launches B when A completes — the operator relaunches by hand
("I want to constantly be planning the next bug or feature… B queues behind
A and starts without a human relaunch").

**Repro:** (1) Complete any `BUG-*` spec run — no retro artifact exists
anywhere in the run's Chronicle output. (2) Approve a second spec while a
supervised run is active — observe that nothing starts it when the first
run's supervise loop exits clean.

**Root cause:** (1) The run pipeline has no post-merge retro step; retros
exist only as prose in the process description. (2) Each `run` invocation
is scoped to one spec; the supervise loop exits when its own tasks merge
and consults nothing else. The full launch-signal plumbing belongs to the
PRD-0020 event daemon; what the engine is missing is a durable queue the
daemon (or the exiting supervise loop, interim) can consume.

**Why now / blast radius:** Both are recurring operator taxes identified in
the gap analysis (W11). Engine-internal only; the queue is run-launch
metadata, not the personal work queue (whose schema is a forbidden surface
here).

## Task T-01: Bug-run retro artifact, committed and queued

- **Story:** S-01
- **Complexity:** S
- **Depends on:** []

For enforce runs whose spec id matches the `BUG-*` convention, after the
final merge (with the digest step), dispatch one retro inference call over
the spec's Context section and the run's verdict/exception history:
"what would have caught this earlier, and which stage should own that
check." Commit the result as a Chronicle artifact (`sdlc.retro.v1`) beside
the run's existing artifacts and append a queue Inbox item linking it (via
the existing queue repository API — no schema change), so the retro lands in
front of the operator and future intake.

### Acceptance criteria

- [x] test: a completed `BUG-*` run produces exactly one `sdlc.retro.v1`
      artifact with stage-attributed recommendations, idempotent across
      resume.
- [x] test: non-bug runs produce no retro artifact and no behavior change.
- [x] test: retro inference failure degrades loud-but-nonblocking: the run
      still completes, and `monitor.log` carries a visible warning.

## Task T-02: Durable run-launch queue consumed at run completion

- **Story:** S-01
- **Complexity:** M
- **Depends on:** []

Add `sdlc-workflow queue-run --spec <path> --repo <path> …` writing a
durable launch record (`<runsDir>/queue/<n>.json`, FIFO, dedup by spec
path) capturing the same argv surface as `launch.json`. When a supervised
enforce run completes with all tasks merged, the supervise loop pops the
head record whose spec is `Approved` on `origin/<default>` and launches it
detached (same relaunch mechanics the continuity daemon already uses);
records whose spec is not yet Approved stay queued. `status` lists queued
specs. This is the interim consumer — the PRD-0020 daemon later owns the
same queue via its watch registry, so the record format is the contract.

### Acceptance criteria

- [x] test: `queue-run` writes a well-formed FIFO record and dedups on the
      same spec path; `status` lists queued entries.
- [x] test: a completing supervised run launches the head queued record
      detached when its spec is Approved, and leaves it queued (with a
      visible monitor line) when it is not.
- [x] test: a failed queued launch surfaces as an escalation, never a
      silent drop; the record is retained for retry.
- [x] agent: diff confined to the queue feature, retro step, and tests —
      no changes to gate or merge semantics.

## Out of scope

- Wake-driven launch on spec approval (PRD-0020 daemon Phase 3 consumes the
  same queue records; SPEC-BUG-one-click-spec-approval emits the signal).
- Retro-driven automation of intake (the retro artifact is evidence for the
  planning conversation, not an auto-filed ticket — yet).
- Cross-repo queues (single `runsDir` scope, matching the engine's
  single-repo posture).
