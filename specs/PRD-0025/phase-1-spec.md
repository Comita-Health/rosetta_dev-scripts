---
id: SPEC-PRD-0025-P1
prd: PRD-0025
phase: 1
status: Approved # Draft | Approved | Done | Superseded
date: 2026-08-10
owner: Russ Watson
envelope:
  allowedPaths: ["sdlc-workflow/**", "CHANGELOG.md"]
  forbiddenSurfaces: ["ci-config", "personal-queue-schema"]
  maxDiffLines: 2800
  budgetK: 200
---

# SPEC-PRD-0025-P1: Phase 1 of PRD-0025 inserts a headless operator-unstick agent turn on the local daemon/supervise path after remediable gate remediation exhausts, adds a non-blocking advisory-issue class for risky proceeds, and surfaces unstick-in-flight / advisory-risky / halted-escalated status tiers—without weakening remediator-first envelope/policy gates or Continuity's ACTION REQUIRED resume path.

## Context

Today, after gate remediation exhausts on a red reviewer or envelope gate, run.handler escalates immediately to a human-blocking ACTION REQUIRED issue and Continuity waits on that issue-state wake—so routine operator unsticks (rebase/integration tip, out-of-band merge + record-merge, resume) require a chat dispatcher. Phase 1 (In-process operator unstick + advisory issues) keeps GateRemediationService first and strict, then dispatches a distinct operator-unstick agent turn in-process on the existing supervise/daemon path (no webhooks, no cross-machine dispatch). Successful clears suppress the blocking escalate for that wave; abstain/budget exhaustion and authority-bound acts (Draft→Approved, live smoke/veto, PHI) still file ACTION REQUIRED on the current EscalationService + issue-state resume path. Risky proceeds keep the train moving and file a separate advisory GitHub issue that BlockerService/Continuity must not treat as a resume gate. Status (run-summary and daemon/status) must expose which escalate tier is active. Out of scope: replacing remediation, waiving authority-bound acts, widening Approved envelopes, GitHub webhooks, or teaching deploy/test mechanics beyond existing .sdlc/ contracts and engine CLIs.

## Task T-01: Persist operator-unstick attempt budget and outcome model on run state

- **Story:** S-01
- **Complexity:** S
- **Depends on:** []

Extend RunState / RunStateRepository (and WORKFLOW_TOKENS / index DI only as needed for later wiring) with per-task unstick attempt counters, durable outcome records (cleared | abstained | risky-proceed | authority-bound | exhausted), and an escalate-tier field consumable by status. Mirror the gateFixAttempts persistence pattern so resume cannot refill the unstick budget. Create sdlc-workflow/src/services/operator-unstick.service.ts as the typed service interface stub if needed for DI registration; full dispatch lands in T-03.

### Acceptance criteria

- [ ] test: RunState persists per-task operator-unstick attempt counts and the latest unstick outcome across save/load without resetting on resume.
- [ ] test: An escalate-tier value for a task can be set to unstick-in-flight, advisory-risky, or halted-escalated and round-trips through RunStateRepository.
- [ ] test: Recording an unstick attempt increments a durable counter that a subsequent load still observes (budget cannot refill from a fresh process).

## Task T-02: Author operator-unstick prompt with explicit operator mandate distinct from gate remediation

- **Story:** S-01
- **Complexity:** M
- **Depends on:** [T-01]

Add sdlc-workflow/src/utils/operator-unstick-prompt.ts (and sdlc-workflow/src/__tests__/operator-unstick-prompt.test.ts). Mandate is rebase/integration tip, out-of-band merge + record-merge, and resume via existing engine CLIs—not re-implementing gate-fix-prompt trim-the-diff remediation. Explicitly forbid Draft→Approved flips, live smoke/veto waivers, PHI handling, raising maxDiffLines/allowedPaths, and mid-run specs/** closeout edits; those must instruct abstain (or risky-advisory only when the engine classifies a proceed) rather than silent policy rewrite. Keep buildGateFixPrompt unchanged and remediator-first.

### Acceptance criteria

- [ ] test: The operator-unstick prompt text includes an explicit operator mandate covering rebase/integration tip, out-of-band merge + record-merge, and resume, and does not reuse the gate-remediation trim-diff contract as its primary instructions.
- [ ] test: The operator-unstick prompt instructs abstention (not silent rewrite) for Draft→Approved flips, live smoke/veto waivers, PHI, raising maxDiffLines/allowedPaths, and mid-run specs/** closeout edits.
- [ ] test: buildGateFixPrompt still forbids widening the envelope / editing the Approved spec, so remediation remains a separate strict path from unstick.

## Task T-03: Dispatch headless operator-unstick after remediable gate remediation exhausts, before ACTION REQUIRED

- **Story:** S-01
- **Complexity:** L
- **Depends on:** [T-01, T-02]

Implement OperatorUnstickService in sdlc-workflow/src/services/operator-unstick.service.ts with tests in sdlc-workflow/src/__tests__/operator-unstick.service.test.ts; wire from run.handler remediationRound / red-gate aggregation only when GateRemediationService returns skipped/failed for exhausted remediable reviewer|envelope findings. Dispatch must work on the local supervise/daemon path with no chat/session object. On cleared (blocker cleared + record-merge/resume as applicable) suppress EscalationService.post for that wave; on abstain/exhaust call the existing escalate + issue-state watch registration path. Set escalate tier to unstick-in-flight while the agent turn runs. Extend run.handler.test.ts coverage rather than inventing a parallel orchestrator.

### Acceptance criteria

- [ ] test: After gate remediation exhausts for a remediable red reviewer or envelope gate, the engine dispatches an operator-unstick agent turn with no chat/session object required, before posting a human-blocking ACTION REQUIRED issue.
- [ ] test: A successful unstick outcome that clears the blocker and records merge / resumes the run produces no human-blocking ACTION REQUIRED escalate issue for that wave.
- [ ] test: When the unstick agent abstains or exhausts its budget without a cleared blocker, EscalationService posts a human-blocking ACTION REQUIRED issue and registers the same durable issue-state wake / resume path used today.
- [ ] test: When the unstick outcome is authority-bound (Draft→Approved, live smoke/veto, or PHI), the engine files a human-blocking ACTION REQUIRED issue and does not auto-clear the wave.
- [ ] agent: On a supervised enforce fixture whose remediable red gate has exhausted gateFixAttempts, status/monitor shows an unstick dispatch occurring with no open chat session before any ACTION REQUIRED issue appears.

## Task T-04: File non-blocking advisory GitHub issues for risky unstick proceeds while keeping the train moving

- **Story:** S-02
- **Complexity:** M
- **Depends on:** [T-03]

Create sdlc-workflow/src/services/advisory-issue.service.ts and sdlc-workflow/src/__tests__/advisory-issue.service.test.ts (or a clearly named advisory path inside escalation.service if that avoids duplicate gh plumbing—keep ACTION REQUIRED title helpers untouched). Advisory issue text must be a separate class from escalationWaveTitle ACTION REQUIRED issues, naming the decision, evidence links, and course-correct steps. Engine or agent 'risky' classification both take the continue path; set escalate tier advisory-risky. Do not emit exception-ledger entries that BlockerService treats as open needs-human blockers.

### Acceptance criteria

- [ ] test: When the unstick agent labels a proceed as risky, or the engine classifies the chosen strategy as risky, the run continues without posting a human-blocking ACTION REQUIRED escalate for that wave.
- [ ] test: A non-blocking advisory GitHub issue is filed whose title/class is distinct from ACTION REQUIRED: SDLC <runId> <taskId> and whose body names the decision, evidence links, and how to course-correct.
- [ ] test: Filing an advisory issue sets the task escalate tier to advisory-risky rather than halted-escalated.

## Task T-05: Exclude advisory issues from Continuity blocker resume gating

- **Story:** S-02
- **Complexity:** S
- **Depends on:** [T-04]

Update BlockerService (and ContinuityService tests) so open advisory issues are never required to close for resumable/blockers-cleared wakes. Only ACTION REQUIRED / exception-backed needs-human issues remain resume gates. Keep EngineResumeWakeAction signal semantics unchanged.

### Acceptance criteria

- [ ] test: An open advisory issue alone does not make BlockerService report an open blocker or block Continuity resume (resumable is not gated on advisory closure).
- [ ] test: An open ACTION REQUIRED issue for a recorded exception still blocks Continuity resume exactly as today.
- [ ] test: continuity.service / blocker.service tests cover the advisory-vs-blocking distinction without requiring the advisory issue to be closed.

## Task T-06: Keep remediator-first strict envelope/policy gates; reject unstick policy rewrites

- **Story:** S-03
- **Complexity:** M
- **Depends on:** [T-02, T-03]

Add regression coverage in gate-remediation / envelope-gate / operator-unstick tests proving ordering (remediate until exhausted, then unstick) and that an unstick prompt/attempt which tries to raise maxDiffLines or edit mid-run specs/** for closeout is rejected or routed to abstain/advisory—never a silent Approved-spec policy rewrite. Do not loosen EnvelopeGateService mid-run specs/** or maxDiffLines enforcement.

### Acceptance criteria

- [ ] test: On a remediable red gate with remaining gateFixAttempts, the engine invokes gate remediation and does not dispatch operator-unstick before remediation is exhausted or skipped for non-remediable reasons.
- [ ] test: Gate remediation still cannot widen the envelope or rewrite Approved product policy (existing trim-only / no-spec-edit invariants remain asserted).
- [ ] test: An unstick attempt that tries to raise maxDiffLines or edit mid-run specs/** for closeout is rejected or routed to abstain / advisory, not applied as a silent policy rewrite to the Approved spec.

## Task T-07: Surface unstick-in-flight, advisory-risky, and halted-escalated tiers on status

- **Story:** S-03
- **Complexity:** M
- **Depends on:** [T-01, T-04]

Extend run-summary TaskCategory (or a sibling escalate-tier projection), run.handler status output, and daemon-status.schema/service JSON so operators can see unstick-in-flight, advisory-risky, and halted-escalated without reading chat. Update sdlc-workflow/README.md and CHANGELOG.md to document the remediator→unstick→advisory/blocking ladder and the three visible tiers. Prefer extending categorizeTasks / daemon status fields over a one-off log scrape.

### Acceptance criteria

- [ ] test: sdlc-workflow status (or equivalent run-summary categorization) distinguishes unstick-in-flight, advisory-risky, and halted-escalated for tasks in those states.
- [ ] test: daemon status --json schema/output includes the active escalate tier (or equivalent field) so unstick-in-flight, advisory-risky, and halted-escalated are machine-readable.
- [ ] agent: With a fixture run held in each of the three tiers, status output shows the active tier without requiring the operator to read chat logs.
- [ ] test: README documents that remediation stays first/strict, unstick carries the operator mandate, advisory issues are non-blocking, and status exposes the three escalate tiers.
