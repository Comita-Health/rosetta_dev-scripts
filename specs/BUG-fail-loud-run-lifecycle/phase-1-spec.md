---
id: SPEC-BUG-fail-loud-run-lifecycle-P1
prd: BUG-fail-loud-run-lifecycle # synthetic id — lightweight bug path, no PRD file
phase: 1
status: Done # Draft | Approved | Done | Superseded
date: 2026-08-04
owner: Russ Watson
envelope:
  allowedPaths:
    [
      'sdlc-workflow/src/**',
      'sdlc-workflow/README.md',
      'specs/BUG-fail-loud-run-lifecycle/**',
      'CHANGELOG.md'
    ]
  forbiddenSurfaces: ['ci-config', 'personal-queue-schema']
  maxDiffLines: 800
  budgetK: 200
---

# SPEC-BUG-fail-loud-run-lifecycle-P1: Every silent run-lifecycle failure becomes loud

## Context

**Symptom:** Across six live sessions (Jul 31 – Aug 4), every run stall was
discovered by the operator asking "what's going on?" — never by the
machinery reporting it. Four distinct silent modes: (a) `run` returned
exit 0 for a spec that didn't exist; (b) a run that crashed before its first
step-cache boundary left no `state.json`, so `status` reported
`RUN_NOT_FOUND` with zero forensics ([#37]); (c) a detached run died with no
terminal record or wake ([#38] — startup-window death was since fixed in
PR #83/#84, but a post-startup silent exit still leaves only a stale
heartbeat); (d) `gh pr merge --delete-branch` exits non-zero when the branch
is checked out in the run's own worktree, so successful merges were believed
failed, filing spurious `merge-blocked` needs-human issues that blocked the
phase gate. Compounding all of them: needs-human escalation issues are filed
with **no assignees** and produce no push notification, so an overnight
stall surfaced as "no updates" at 9:52 AM.

**Repro:** (a) `run --spec specs/does-not-exist.md --detach` → observe exit
code; (b) `kill -9` a run between intake and the first recorded step, then
`status --run-id <id>`; (c) `kill -9` the detached child after wave 1
starts, then wait — no wake, no terminal record; (d) enforce-merge a task
whose branch is checked out in the run worktree with `--delete-branch`
semantics active.

**Root cause:** Run state is only persisted at step-cache boundaries; the
detached child has no exit trap that records termination; the merge step
treats any thrown `gh pr merge` error as merge failure without reconciling
actual PR merge state via the API (the catch block files `merge-blocked`
unconditionally); escalation delivery was built queue-side only — the
GitHub-issue half has no assignee and no wake integration. Some modes may
have been partially fixed since the audit (PRs #83/#84/#87, gate
auto-recover): **each task below must first verify current behavior on
`main` and reduce to a regression-test-only change where the behavior
already holds.**

**Why now / blast radius:** Silent failure is the dominant failure mode in
the gap analysis (W3) and the direct cause of overnight babysitting. All
changes are engine-internal (`sdlc-workflow/src/**`); no CI or queue-schema
surfaces.

## Task T-01: Run state exists from invocation start (#37)

- **Story:** S-01
- **Complexity:** S
- **Depends on:** []

Persist `state.json` (run id, spec path/digest, base SHA, launch argv,
`startedAt`, empty step map) at run start — before intake completes and
before the first step-cache boundary. `status` must never answer
`RUN_NOT_FOUND` for a run that started, and a crash at any point leaves at
least the launch record for forensics. Preserve the existing no-op
invocation guarantee (a refused intake that persists nothing today may
instead persist a state with a recorded refusal — but must not create
half-runs that the continuity daemon would relaunch).

### Acceptance criteria

- [x] test: a run killed between intake and the first recorded step leaves a
      readable `state.json` with run id, spec digest, and `startedAt`; a
      subsequent `status --run-id` reports the run instead of
      `RUN_NOT_FOUND`.
- [x] test: a refused intake (e.g. spec not Approved) records the refusal
      reason in run state (or provably persists nothing the daemon would
      relaunch), and exits non-zero.
- [x] test: existing resume behavior over the step cache is unchanged for a
      normally-progressing run.

## Task T-02: A detached run can never exit silently (#38)

- **Story:** S-01
- **Complexity:** M
- **Depends on:** [T-01]

Startup-window death detection landed in PR #83/#84; close the remaining
window. The supervise/detached child installs exit handlers so that **any**
termination (clean exit, thrown error, SIGTERM) writes a terminal record
(`supervise.exit` with code + reason, a final `monitor.log` line) and emits
a durable wake. An abnormal exit (non-zero, or zero with unmerged incomplete
tasks) must be distinguishable from legitimate completion in the artifacts
alone. SIGKILL cannot run a handler by definition — that detection remains
the continuity layer's liveness check; document the boundary.

### Acceptance criteria

- [x] test: a supervise loop that throws after wave 1 writes `supervise.exit`
      with a non-zero code and reason, appends a terminal `monitor.log`
      line, and emits a wake event.
- [x] test: clean all-merged completion writes `supervise.exit` code 0 and is
      distinguishable from an abnormal zero-exit (incomplete tasks) in the
      recorded artifacts.
- [x] test: `run --detach` propagates a non-zero exit (never 0) when the
      spec path does not exist or intake refuses — covering the observed
      "exit 0 for a spec that didn't exist".
- [x] agent: README states the detection boundary — exit traps own
      trappable terminations; the continuity layer owns SIGKILL/power-loss
      via liveness.

## Task T-03: Merge results are reconciled against GitHub, never guessed

- **Story:** S-01
- **Complexity:** S
- **Depends on:** []

In the enforce merge step, a thrown merge call must not directly file
`merge-blocked`: first query the PR's actual merge state via the API. If the
PR merged (the `--delete-branch`-with-checked-out-worktree false negative),
record `mergedSha` and proceed as success; only a confirmed-unmerged PR
escalates. Verify-first: a "merge-reconciliation fix" is referenced in code
comments — if reconciliation already exists, this task reduces to regression
tests pinning the checked-out-branch scenario end-to-end (no spurious
`merge-blocked` exceptions, phase gate unblocked).

### Acceptance criteria

- [x] test: merge call throws but the PR reports merged → task records the
      real merge SHA, no `merge-blocked` exception is filed, no needs-human
      issue is posted, and the phase gate sees the task as merged.
- [x] test: merge call throws and the PR is genuinely unmerged → existing
      escalation behavior is preserved.
- [x] agent: diff confined to the merge step, its repositories, and tests.

## Task T-04: Escalations are assigned and delivered, not parked

- **Story:** S-01
- **Complexity:** S
- **Depends on:** []

Needs-human escalation issues must carry an assignee and produce a durable
wake. Add an operator login to the run configuration surface (flag or config
consumed at launch; no hardcoded usernames in engine code) and pass it as
the issue assignee; emit a wake-inbox event for every escalation posted (and
keep the existing queue item). GitHub failures remain swallowed-by-design
for the run's progress, but a swallowed escalation post must itself append a
loud line to `monitor.log`.

### Acceptance criteria

- [x] test: with an operator configured, posted needs-human issues include
      the assignee; without one, issues still post (no crash) and
      `monitor.log` warns that no assignee is configured.
- [x] test: every escalation entry emits exactly one wake event (idempotent
      across resume, matching the existing title-idempotence).
- [x] test: a failed GitHub issue post appends a visible `monitor.log`
      warning while the run continues.

## Out of scope

- The sandbox health-check diffing `HEAD` instead of `SDLC_SANDBOX_SHA` —
  consumer-repo script defect (`comita_admissions`), tracked with the W6
  delivery-truth item.
- Watcher/wake-chain architecture and headless wake consumption (PRD-0020).
- Gate retrigger paths and verdict-cache invalidation (W4 self-healing PRD).
- Heartbeat step-context coverage through CI/sandbox waits (W6).
