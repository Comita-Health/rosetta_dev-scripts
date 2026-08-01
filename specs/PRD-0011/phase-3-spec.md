---
id: SPEC-PRD-0011-P3
prd: PRD-0011
phase: 3
status: Approved # Draft | Approved | Done | Superseded
date: 2026-08-01
owner: Russ Watson
envelope:
  allowedPaths: ['sdlc-workflow/**', 'specs/PRD-0011/**']
  forbiddenSurfaces: ['migrations', 'auth', 'ci-config', 'production-deploy', 'personal-queue-schema']
  maxDiffLines: 2500
  budgetK: 200
---

# SPEC-PRD-0011-P3: Phase 3 of PRD-0011 turns the calibrated shadow machinery live: implementation fans out across all ready spec tasks in parallel worktrees, task branches become real PRs with CI monitoring and a bounded fix cycle, machine gates enforce (all green auto-merges, any red blocks and escalates), each merged phase auto-deploys to the sandbox and posts a PRD-0007 digest whose veto triggers revert, and humans are interrupted only by exception. Promotion beyond the sandbox remains outside the workflow — always a human decision.

## Context

Phase 2 proved every gate in shadow mode against live runs (SPEC-PRD-0011-P2, all criteria evidenced 2026-08-01): the verdicts the gates computed matched human judgment, the step graph survived kill-resume, and outputs landed in the Chronicle. Phase 3 is the payoff: the same gates flip from recording verdicts to enforcing them, and the single-slot executor becomes a dependency-ordered pool. The load-bearing invariants carry forward unchanged — no code without an approval record (S-01 of P2), no path to any environment beyond the sandbox, and no code path that converts a red gate into a merge. Escalation replaces checkpoints: reviewer disagreement, a third failing CI fix attempt, envelope breach, or budget exhaustion interrupts the human; everything else advances on evidence. Failing tasks must never block passing ones (PRD §6 partial failures).

Stories sliced from PRD-0011 §7 Phase 3: S-01 (parallel implementation fan-out with dependency ordering), S-02 (live machine gates with auto-merge on green), S-03 (real PR lifecycle with CI monitoring and bounded fixes), S-04 (post-merge sandbox deploy, digest, and veto-triggered revert), S-05 (escalation by exception and partial-failure isolation).

## Task T-01: Dependency-ordered parallel task pool

- **Story:** S-01
- **Complexity:** L
- **Depends on:** []

Replace the single-slot executor with a pool: every spec task whose dependsOn are all merged (not merely implemented) is eligible, and eligible tasks run concurrently, each in its own worktree on its deterministic branch. Concurrency is bounded by a --max-parallel option (default 3). The T-09 step graph already keys every step by task and inputs digest, so parallel chains must not contend on run state — serialize state writes behind a single writer. A failed task blocks only its dependents; independent tasks continue. Kill-resume semantics must hold across the pool: resuming a run rediscovers every in-flight task and reuses cached steps exactly as in the single-slot loop.

### Acceptance criteria

- [x] test: given a spec with independent ready tasks, the pool executes them concurrently in separate worktrees and records a per-task result for each, with concurrent state writes serialized and none lost
- [x] test: a task whose dependsOn is unmerged is not started, and a failed task blocks its dependents while unrelated tasks proceed to completion
- [x] test: killing a pooled run and resuming reuses every completed task's cached steps and re-executes only interrupted or not-yet-started work

## Task T-02: Task-branch push and PR lifecycle

- **Story:** S-03
- **Complexity:** M
- **Depends on:** [T-01]

Push each task branch and open a real PR (gh, operator auth) with a deterministic title and a body generated from the spec task and its gate verdicts. Idempotent per branch: resume must find the existing PR rather than opening a duplicate. Record the PR URL in the task result (PRD-0011 §4 TaskResult.prUrl). The PR is the reviewer-gate subject and the CI-gate subject — pushing is what makes the phase-2 'blocked (branch not pushed)' CI verdict a live signal.

### Acceptance criteria

- [x] test: a completed implementation step pushes the task branch and opens a PR whose title and body derive deterministically from the spec task, recording the PR URL in the task result
- [x] test: re-running the step with an existing PR for the branch reuses it — no duplicate PR, same recorded URL
- [x] test: push or PR-creation failure records a failed step with the tool output as detail and does not corrupt run state

## Task T-03: Live CI monitoring with a bounded fix cycle

- **Story:** S-03
- **Complexity:** M
- **Depends on:** [T-02]

Poll the pushed branch's check runs until terminal (bounded timeout). On failure, dispatch a fix agent in the task worktree with the failing check output as context, commit and push the fix, and re-poll — at most 3 attempts total, tracked in the existing ciFixAttempts state. The third failing attempt raises the ci-fix-exhausted escalation (T-06 of P2 already derives it); the task halts for human triage. The CI gate verdict consumed by the aggregator is the final post-cycle state.

### Acceptance criteria

- [x] test: a failing check dispatches the fix agent with the failing output in its prompt, increments ciFixAttempts, and re-evaluates after the fix is pushed
- [x] test: the third failing attempt stops the cycle, records the escalation, and no fourth agent dispatch occurs
- [x] test: a green check run within the attempt budget yields a pass CI verdict carrying the check-run evidence

## Task T-04: Gate enforcement and auto-merge on green

- **Story:** S-02
- **Complexity:** L
- **Depends on:** [T-02, T-03]

Flip the aggregate phase gate from shadow to enforcing: when envelope, verification, reviewer concurrence, and CI are all green for a task, merge its PR automatically and record the merged SHA through the existing Chronicle merge artifact (sdlc.merge.v1). Any red gate blocks the merge and escalates — there must be no code path that merges on a red gate, the enforcing mirror of the phase-2 invariant that no code path converted a disagree into an approval. Shadow mode remains available behind a flag for calibrating new repos. Merging is the only advance mechanism this phase automates; promotion beyond the sandbox stays human.

### Acceptance criteria

- [x] test: with all four gates green the task PR is merged automatically and the merged SHA is recorded in the run state and Chronicle merge artifact
- [x] test: each single red gate (envelope breach, verification fail, reviewer disagree, CI fail) blocks the merge, records the escalation, and no merge call is issued — asserted for all four gates
- [x] test: with the shadow flag set, verdicts are recorded but no merge call is ever issued regardless of gate outcomes
- [ ] agent: on a live run, a task with all gates green auto-merges its PR and the recorded merged SHA matches the remote merge commit

## Task T-05: Post-merge sandbox deploy, digest, and veto-triggered revert

- **Story:** S-04
- **Complexity:** L
- **Depends on:** [T-04]

When every task of a spec phase has merged, deploy the merged default branch to the sandbox via the repo-owned contract (same .sdlc/environments.json machinery, same SHA-idempotency and health check) and post the phase digest to the PRD-0007 queue. The veto is non-blocking: the run advances immediately, and a veto expressed on the queue item (a machine-readable [veto] tag) triggers revert — a revert commit of the phase's merges pushed through a PR, sandbox redeployed at the reverted SHA, and the revert recorded as a Chronicle artifact. Reverts are cheap in the sandbox by design; nothing here touches any other environment.

### Acceptance criteria

- [x] test: after the last task of a phase merges, the merged branch deploys to the sandbox exactly once (SHA-idempotent on resume) and the digest posts to the queue with links to the merged SHAs and verdict evidence
- [x] test: a veto tag detected on the digest item produces a revert commit covering the phase's merges, a redeploy at the reverted SHA, and a Chronicle revert artifact; absence of a veto changes nothing
- [x] test: no deploy, revert, or any other code path in this task can target an environment other than sandbox

## Task T-06: Escalation surface, budget enforcement, and partial-failure reporting

- **Story:** S-05
- **Complexity:** M
- **Depends on:** [T-01, T-04]

Escalations stop being ledger entries and start interrupting: each escalation trigger (reviewer disagreement, third failing CI fix attempt, envelope breach, budget exhaustion) posts an action-required queue item identifying the task, the trigger, and the evidence, and halts that task — only that task. Track token spend against the envelope's budgetK across all agents in the run; exhaustion halts new agent dispatches pool-wide while letting in-flight gate evaluations finish. The run summary distinguishes merged, halted-escalated, and blocked-by-dependency tasks so a partially failed run surfaces exactly what needs human attention (PRD §6).

### Acceptance criteria

- [ ] test: each of the four escalation triggers posts an action-required queue item naming the task, trigger, and evidence refs, and halts only the affected task
- [ ] test: cumulative token spend exceeding budgetK halts new agent dispatches across the pool, records the budget-exhaustion escalation, and in-flight non-agent steps complete
- [ ] test: a run ending with a mix of merged, escalated, and dependency-blocked tasks reports each task in the correct category via the status interface
- [ ] agent: an operator agent reviews a live partially-failed run via the status interface and confirms the escalated task's queue item contains everything needed to triage without consulting internal state files
