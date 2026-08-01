---
id: SPEC-PRD-0011-P2
prd: PRD-0011
phase: 2
status: Approved # Draft | Approved | Done | Superseded
date: 2026-07-31
owner: Russ Watson
envelope:
  allowedPaths: ['sdlc-workflow/**', 'specs/PRD-0011/**']
  forbiddenSurfaces: ['migrations', 'auth', 'ci-config', 'production-deploy', 'personal-queue-schema']
  maxDiffLines: 2500
  budgetK: 200
---

# SPEC-PRD-0011-P2: Phase 2 of PRD-0011 delivers the single-task implementation loop end to end: one task from an approved implementation spec is executed by an agent in an isolated worktree, its branch is deployed to the sandbox, and every machine gate — envelope compliance, tiered acceptance-criteria verification, CI, and independent reviewer concurrence — runs in shadow mode, recording verdicts and would-escalate exceptions without enforcing them. Human approval remains the sole advance mechanism this phase; the loop's outputs are committed to the Chronicle and the run is resumable from cached step results.

## Context

Phase 1 established spec generation from a PRD with the single up-front approval pause (S-01). Phase 2 exercises that approved spec against exactly one task to de-risk the gate machinery before Phase 3 turns on parallel per-task execution, gate enforcement, auto-advance, and veto-triggered revert. Shadow mode means every gate computes and persists the verdict it would have enforced (including escalation triggers: reviewer disagreement, third failing CI fix attempt, envelope breach, budget exhaustion) so gate behavior can be validated against human judgment and gate policy can begin learning from track record (S-05). Nothing in this phase auto-promotes beyond the sandbox, and no code runs without a spec approval record.

## Task T-01: Approved-spec intake and single-task worktree executor

- **Story:** S-02
- **Complexity:** M
- **Depends on:** []

Consume the phase-1 implementation-spec artifact as the contract; do not re-derive or mutate it. Select exactly one ready task (all dependsOn satisfied) — no parallelism this phase, so keep the executor interface shaped for a future pool but implement a single slot. Worktree isolation must guarantee the primary checkout is never dirtied; branch naming must be deterministic from run ID plus task ID so resume (T-09) can rediscover in-flight work. Refusing to run without an approval record is the S-01 no-code-before-approval invariant enforced at the execution boundary.

### Acceptance criteria

- [x] test: given a spec fixture lacking an approval record, the executor refuses to start and records a blocked verdict with reason 'unapproved-spec'
- [x] test: given an approved spec fixture, the executor selects exactly one task whose dependsOn are all satisfied, and reports no-ready-task without side effects when none qualify
- [x] test: the implementation agent runs in a newly created git worktree on a branch named deterministically from run ID and task ID, and the primary checkout shows no modifications afterward
- [x] test: an implementation-agent failure produces a recorded per-task failure result rather than an unhandled error, leaving the run in a resumable state

## Task T-02: Envelope compliance gate in shadow mode

- **Story:** S-02
- **Complexity:** S
- **Depends on:** [T-01]

Evaluate the task branch diff against the spec's blast-radius envelope: allowedPaths globs, forbiddenSurfaces labels resolved via a repo-level surface map, and maxDiffLines as a hard cap. Shadow semantics: always compute and persist the verdict with a wouldEscalate flag, never block. The surface-label resolution must be data-driven so labels like 'migrations' or 'auth' are not hardcoded path lists in gate logic.

### Acceptance criteria

- [x] test: a diff confined to allowedPaths and under maxDiffLines yields a pass verdict
- [x] test: a diff touching a path labelled by any forbiddenSurfaces entry, or exceeding maxDiffLines, yields a breach verdict identifying the offending paths or line count
- [x] test: in shadow mode a breach verdict is persisted with wouldEscalate=true and the run proceeds unblocked

## Task T-03: Sandbox deployment of the task branch build

- **Story:** S-04
- **Complexity:** M
- **Depends on:** [T-01]

The verification runner (T-04) needs a running sandbox built from the task branch, so this phase deploys pre-merge rather than post-merge; the post-merge auto-deploy and veto-triggered revert land in a later phase. Deployment must be idempotent per commit SHA so resume does not redeploy unchanged builds, and must expose a health check the verifier can poll. Hard constraint from S-04: no code path here may promote beyond the sandbox environment.

> **Amendment (2026-07-31):** deployment mechanics are repo-owned, not
> engine-owned. The repo declares its sandbox in
> `.sdlc/environments.json` (`sandbox` → `deployCommand`,
> `healthCommand`, `timeoutMinutes`); commands receive the deployed SHA
> as `SDLC_SANDBOX_SHA` and the health output must echo it. The engine
> reads **only** the `sandbox` entry — no API exists for any other
> environment, which is how the S-04 hard constraint is enforced
> structurally. Informed by a real adopter whose "deploy" is a branch
> push that triggers a CDK pipeline: no built-in adapter could own that.

### Acceptance criteria

- [x] test: deploying a task branch produces a sandbox instance whose health endpoint reports the deployed commit SHA
- [x] test: redeploying the same SHA is a no-op that reports the existing healthy instance
- [x] test: no deployment target other than the sandbox environment is reachable from this code path, asserted by exercising the deployer against the full environment configuration

## Task T-04: Tiered acceptance-criteria verification runner with attached evidence

- **Story:** S-03
- **Complexity:** L
- **Depends on:** [T-03]

Parse the spec's per-task criteria by verification-tier prefix (test:/agent:/manual:) and dispatch accordingly: test-tier criteria run as scripted checks in CI, agent-tier criteria are handed to a verifier agent that drives the running sandbox interface, manual-tier criteria mark the verdict as requiring a human and disable any future auto-advance for the phase. Evidence is first-class: every criterion verdict must reference its artifact (test output, agent transcript, screenshot) by stable ID so T-08 can commit it to the Chronicle. The verifier agent must be independent of the implementation agent — no shared conversation state.

### Acceptance criteria

- [x] test: criteria are parsed by tier prefix and a criterion with a missing or unknown prefix fails spec validation before any execution begins
- [x] test: every test-tier criterion executes as a scripted check and its pass/fail result plus captured output are recorded per criterion
- [ ] agent: for a sample task with agent-tier criteria, a verifier agent exercises the running sandbox interface and each resulting verdict carries the agent transcript as attached evidence
- [x] test: the aggregate phase verification verdict is green only when every criterion verdict is green, and a manual-tier criterion forces the verdict into a human-required state

## Task T-05: Independent reviewer-agent concurrence gate in shadow mode

- **Story:** S-02
- **Complexity:** M
- **Depends on:** [T-01]

A reviewer agent with no shared context with the implementation agent reviews the task PR (diff, spec task, envelope) and returns concur or disagree with cited reasons. Shadow semantics as in T-02: disagreement is recorded with wouldEscalate=true, never auto-resolved and never blocking this phase. Persist the reviewer's reasoning verbatim — it is the training signal gate policy will consume (S-05), and the exception ledger (T-06) needs it for human triage context.

### Acceptance criteria

- [x] test: the reviewer agent is invoked with only the PR diff, the spec task, and the envelope — no implementation-agent conversation state — asserted via the constructed prompt payload
- [ ] agent: on a sample task PR, the reviewer agent produces a concur-or-disagree verdict with cited reasons, and the full review transcript is attached to the verdict
- [x] test: a disagree verdict is persisted with wouldEscalate=true and does not block the run, and no code path exists that converts a disagree verdict into an auto-approval

## Task T-06: Shadow gate aggregator and exception ledger

- **Story:** S-02
- **Complexity:** M
- **Depends on:** [T-02, T-04, T-05]

Combine the four machine gates — CI status, verification verdict (T-04), reviewer concurrence (T-05), envelope compliance (T-02) — into a single phase-gate verdict recorded in shadow mode; human approval remains the only actual advance mechanism this phase. The exception ledger records every would-escalate trigger from S-02 (reviewer disagreement, third failing CI fix attempt, envelope breach, budget exhaustion) with enough context for later human triage. Track token spend against the budget supplied at invocation so exhaustion is a real computed trigger, not a stub.

> **Amendment (2026-07-31):** the CI input to the aggregator is the real
> gate — GitHub check runs for the task branch head SHA, queried through
> the operator's `gh` session. An unpushed task branch (the shadow-mode
> default) records an honest `blocked` CI verdict rather than a stub.

### Acceptance criteria

- [x] test: the aggregate gate verdict is green only when CI is green, the verification verdict is green, the reviewer concurs, and the envelope check passes; each failing combination yields red with the failing gates enumerated
- [x] test: a third consecutive failing CI fix attempt on the task writes a wouldEscalate ledger entry with attempt history
- [x] test: cumulative token spend exceeding the invocation budget writes a budget-exhaustion wouldEscalate ledger entry
- [x] test: in shadow mode a red aggregate verdict is persisted but does not advance, block, or merge anything — the run halts awaiting human approval regardless of verdict color

## Task T-07: Phase-boundary digest posting in shadow mode

- **Story:** S-04
- **Complexity:** S
- **Depends on:** [T-06]

Post a digest to the PRD-0007 personal queue at the phase boundary summarizing the task outcome, gate verdicts, evidence links, and any would-escalate ledger entries. This phase the digest is informational only: veto semantics and revert land with gate enforcement in a later phase, so consume the existing PRD-0007 queue API as-is and do not modify queue schema (forbidden surface). Digest content should already match the eventual veto-window format so the later phase only changes what happens after posting.

### Acceptance criteria

- [x] test: completing the single-task loop posts exactly one digest to the personal queue containing the task ID, aggregate gate verdict, evidence artifact links, and any exception-ledger entries
- [x] test: digest posting uses the existing PRD-0007 queue API and the queue consumer contract test passes unchanged
- [x] test: no veto-handling or revert code path is invoked from digest posting in this phase, asserted by exercising the digest flow with a simulated veto response

## Task T-08: Chronicle artifact commits for run outputs

- **Story:** S-05
- **Complexity:** M
- **Depends on:** [T-06]

Commit the run's structured outputs to the Chronicle: the consumed implementation spec, per-task results, per-gate and aggregate verdicts with their evidence references, exception-ledger entries, and merged SHAs when a human approves a merge. Schema design is the real work here — verdicts must carry gate identity, inputs digest, outcome, and evidence refs in a shape gate policy can later consume to learn from track record, so version the artifact schema from day one.

### Acceptance criteria

- [x] test: a completed single-task run commits Chronicle artifacts for the spec, the per-task result, every gate verdict, and the exception ledger, each validating against a versioned artifact schema
- [x] test: a human-approved merge records the merged SHA in the run's Chronicle artifact
- [x] test: every per-phase verdict artifact includes gate identity, an inputs digest, the outcome, and resolvable evidence references, verified by a consumer-style test that reads verdicts back through the gate-policy query interface

## Task T-09: Resumable run state with cached step results

- **Story:** S-05
- **Complexity:** L
- **Depends on:** [T-01, T-06]

Persist run state as a step graph where each step's result is cached under a key derived from its inputs digest (spec task content, commit SHA, gate inputs). On resume, replay the graph: cache hits are reused, and only steps whose inputs changed or which never completed re-execute — this is why T-01 branch naming and T-03 deploy idempotency are deterministic. Kill-resume must be safe at any step boundary, including mid-verification, without duplicating side effects such as sandbox deploys or digest posts.

### Acceptance criteria

- [x] test: killing a run after the implementation step and resuming reuses the cached implementation-agent result and worktree branch without re-invoking the agent
- [x] test: modifying a task's spec content between runs invalidates only that task's cached steps, and unaffected cached results are still reused
- [x] test: a kill-resume cycle at each step boundary in the single-task loop produces no duplicate sandbox deployments and no duplicate digest posts
- [ ] agent: an operator agent kills a live run mid-verification, resumes it, and confirms via the run-status interface that the run completes with only the interrupted and downstream steps re-executed
