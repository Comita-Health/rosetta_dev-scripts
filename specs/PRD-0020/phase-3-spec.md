---
id: SPEC-PRD-0020-P3
prd: PRD-0020
phase: 3
status: Approved # Draft | Approved | Done | Superseded
date: 2026-08-10
owner: Russ Watson
envelope:
  allowedPaths: ["sdlc-workflow/**", "team-setup/templates/root/.cursor/skills/deploy-verify-watch/**", "team-setup/templates/root/.claude/skills/deploy-verify-watch/**", "team-setup/templates/root/.cursor/skills/issue-resolve-watch/**", "team-setup/templates/root/.claude/skills/issue-resolve-watch/**", "CHANGELOG.md"]
  forbiddenSurfaces: ["ci-config", "personal-queue-schema"]
  maxDiffLines: 3000
  budgetK: 250
---

# SPEC-PRD-0020-P3: Phase 3 of PRD-0020 completes full watch coverage and headless wake dispatch: workflow-run, run-supervisor, and queue-item adapters join issue-state on the shared poll/inbox path; deploy-verify and issue-resolve skills become thin daemon clients so no session-mortal watcher remains; wakes with a registered HeadlessAction dispatch a non-interactive agent turn with a persisted transcript while chat notify stays a best-effort mirror; and a scheduled coverage digest makes watched vs pending state machine-answerable without a chat session.

## Context

Phase 1 shipped the launchd-managed daemon core, durable watch registry and unified wake inbox, pr-review/pr-checks polling, atomic wake consumption with NotifyWakeAction, daemon status, and the thin pr-approve-watch client. Phase 2 folds continuity (dead-supervisor relaunch, per-run stale-agent kill, abandoned-run flagging, blocker-close via issue-state + EngineResumeWakeAction), retires sdlc-continuity-daemon.sh and its StartInterval plist, and makes poll/process failures loud via KeepAlive plus operator-visible poll-error wakes. Phase 3 (Full watch coverage + headless dispatch) must not re-implement continuity relaunch/kill logic or touch personal-queue-schema / ci-config: it adds the remaining WatchKind adapters, wires WatchRegistration.action through commitWatchSignal into a HeadlessDispatchWakeAction that runs DaemonConfig.headlessRunner (cursor-agent -p / print mode) with transcriptDir persistence and per-kind concurrency caps, absorbs the remaining session-mortal deploy-verify-watch and issue-resolve-watch bash poll loops into register/status clients, and schedules a coverage digest over the existing status surface. Workspace-agnostic DaemonConfig rules still apply — zero hardcoded orgs, repos, consumer paths, or domain rules.

## Task T-01: workflow-run watch adapter for deploy completion

- **Story:** S-01
- **Complexity:** L
- **Depends on:** []

Add `sdlc-workflow/src/services/workflow-run-watch-source.adapter.ts` (+ `sdlc-workflow/src/__tests__/workflow-run-watch-source.adapter.test.ts`) implementing IWatchSourceAdapter for kind `workflow-run`. Extend `github-watch-source.repository.ts` with a getWorkflowRun (or equivalent gh run view/list under the workspace activate script) that normalizes terminal conclusions into distinct signals (e.g. deploy-succeeded / deploy-failed) and marks the watch terminal on completion. Deliver only via commitWatchSignal / shared WakeInbox — never a bespoke inbox. Register the adapter in index.ts DI beside pr-review/pr-checks/issue-state. Reuse DeployObservationRepository patterns for status/conclusion sets where helpful; do not dispatch deploys or edit ci-config workflows.

### Acceptance criteria

- [ ] test: a workflow-run watch whose GitHub Actions run reaches a terminal success conclusion emits exactly one deploy-succeeded (or equivalent) wake through the shared inbox writer and expires the watch
- [ ] test: a terminal failure conclusion emits a distinct deploy-failed wake and does not emit a success wake
- [ ] test: the workflow-run adapter never imports the daemon store or calls writeWake/emitOnce directly, enforced by the existing module-boundary test pattern
- [ ] test: two workspace roots with the same remote workflow run id produce wakes only in the workspace that registered the watch

## Task T-02: run-supervisor watch adapter on shared engine state readers

- **Story:** S-02
- **Complexity:** L
- **Depends on:** []

Add `sdlc-workflow/src/services/run-supervisor-watch-source.adapter.ts` (+ tests under `sdlc-workflow/src/__tests__/`) for kind `run-supervisor`. Poll using the same engine artifacts/readers continuity uses — RunStateRepository, ProcessDetachRepository.isAlive on supervise.pid, heartbeat.jsonl / run-completion helpers — never bash pgrep or a second heartbeat parser. Emit idempotent signals for supervisor-dead and heartbeat-gap (and recover/re-arm semantics so a healed heartbeat can notify again). Wakes must use commitWatchSignal on the durable inbox path. Relaunch/kill/resume side effects remain Phase 2 continuity modules and EngineResumeWakeAction; this adapter only observes and wakes. Wire DI + daemon watch-register CLI so runId targets are expressible (daemon.handler today only advertises owner/repo#N kinds).

### Acceptance criteria

- [ ] test: a fixture unfinished run with a dead supervise.pid yields exactly one supervisor-dead wake via the shared inbox writer and constructs no chat or conversation object
- [ ] test: an implementation heartbeat older than the configured gap threshold yields exactly one heartbeat-gap wake; a healthy heartbeat yields none
- [ ] test: the adapter calls engine state readers (RunStateRepository / ProcessDetachRepository / run-completion) rather than shelling out to continuity bash, enforced by a module-boundary or source-contract test
- [ ] test: after a heartbeat-gap wake, repeated ticks do not re-emit until the heartbeat recovers and a new gap occurs
- [ ] agent: with a live daemon, killing a detached run supervisor mid-wave produces a supervisor-dead (or continuity-paired) wake in that workspace inbox within one poll interval without opening an editor

## Task T-03: queue-item watch adapter for digest veto tags

- **Story:** S-01
- **Complexity:** M
- **Depends on:** []

Add `sdlc-workflow/src/services/queue-item-watch-source.adapter.ts` (+ tests) for kind `queue-item`. Read veto/follow-up tags through the existing QueueRepository.itemTags API only — do not modify `queue.repository.ts` (personal-queue-schema). Target identity stays runId per watch-registry; correlate to the phase digest title fragment the engine already posts. Emit a single idempotent veto (and optionally cleared) signal onto the shared wake path; terminalize or re-arm per PRD queue-item semantics without performing revert/redeploy inside the adapter (check-veto / run handler already owns that). Register in DI and extend known-watch-target / status unwatched coverage for queue-item entries.

### Acceptance criteria

- [ ] test: when QueueRepository.itemTags reports a veto tag for the watched digest item, exactly one queue-item veto wake is committed through the shared inbox writer
- [ ] test: absence of a veto tag produces no wake; re-polling the same veto does not create a duplicate wake id
- [ ] test: the queue-item adapter does not modify queue.repository.ts and performs no deploy or Draft→Approved transition
- [ ] test: an unwatched queued digest/run appears under daemon status unwatched as kind queue-item

## Task T-04: Expand issue-state signals for issue-resolve coverage

- **Story:** S-01
- **Complexity:** M
- **Depends on:** []

Extend `issue-state-watch-source.adapter.ts` and `github-watch-source.repository.ts` so issue-state watches cover the actionable signals the retiring issue-resolve skill observed (at minimum closed already shipped; add human_comment and linked_pr as distinct normalized signals with idempotent ids) while keeping needs-human blocker-close compatible with EngineResumeWakeAction. Delivery remains scheduler-owned via commitWatchSignal. Do not reintroduce a session-mortal poll loop. Update watch-source-adapters tests accordingly.

### Acceptance criteria

- [ ] test: a new human issue comment on a watched issue emits a distinct human_comment wake once and does not duplicate on re-poll of the same comment id
- [ ] test: detecting a newly linked PR emits a distinct linked_pr wake; issue closed still emits closed and terminals the watch
- [ ] test: issue-state signals continue to share the same wake field schema as pr-review/pr-checks and never bypass the shared inbox writer

## Task T-05: HeadlessDispatchWakeAction with persisted transcripts

- **Story:** S-03
- **Complexity:** L
- **Depends on:** []

Create `sdlc-workflow/src/services/headless-dispatch-wake.action.ts` (+ `sdlc-workflow/src/__tests__/headless-dispatch-wake.action.test.ts`) implementing IWakeAction for HeadlessAction.kind agent-dispatch. Invoke the configured DaemonConfig.headlessRunner / AgentRunnerRepository non-interactively (cursor-agent print mode `-p`, matching current AgentRunnerRepository flags) with the watch/wake scoped prompt; write stdout/stderr (and exit metadata) under action.transcriptDir so the transcript survives process restart. Enforce per-kind concurrency caps and dedup so a wake storm cannot fan out unbounded agent runs. Support engine-command as argv dispatch without inventing a chat session. Register beside NotifyWakeAction in index.ts; the daemon must not hold a conversation object.

### Acceptance criteria

- [ ] test: executing headless dispatch for a wake with action.kind agent-dispatch runs the configured headlessRunner non-interactively and writes a transcript file under transcriptDir
- [ ] test: when the per-kind concurrency cap is saturated, an additional agent-dispatch wake is not started until a slot frees, and no duplicate in-flight dispatch is created for the same wake id
- [ ] test: headless dispatch constructs no chat or conversation object and does not require an editor session
- [ ] test: engine-command actions invoke the configured argv and record success/failure without going through agent-dispatch

## Task T-06: Route registered watch actions through wake consumption

- **Story:** S-03
- **Complexity:** M
- **Depends on:** [T-05]

Extend `watch-wake-commit.ts` (and WakeEvent data/contract as needed in types.ts) so a watch's HeadlessAction is copied onto the committed wake. Update WakeConsumptionService so a wake with a registered headless/engine action invokes HeadlessDispatchWakeAction and records consumedBy including headless-dispatch; NotifyWakeAction remains registered as a best-effort mirror whose failure never blocks or gates headless completion (existing action-failure recording). Wakes without action keep notify-only behavior. Cover with wake-consumption and integration tests; document in CHANGELOG.md.

### Acceptance criteria

- [ ] test: a wake committed from a watch that declares action.kind agent-dispatch is consumed with consumedBy reflecting headless-dispatch and the headless action runs to completion
- [ ] test: forcing NotifyWakeAction / chat-mirror failure does not prevent headless dispatch from completing or the wake from remaining consumed
- [ ] test: a wake with no registered action does not invoke headless dispatch and still allows best-effort notify
- [ ] agent: against a scratch workspace daemon with no editor open, approving a PR whose pr-review watch declares a headless action produces a consumed wake and a persisted headless transcript within one poll interval

## Task T-07: Absorb deploy-verify and issue-resolve skills into thin daemon clients

- **Story:** S-01
- **Complexity:** M
- **Depends on:** [T-01, T-04]

Convert `team-setup/templates/root/.cursor/skills/deploy-verify-watch/scripts/watch-deploy-verify.sh` and `issue-resolve-watch/scripts/watch-issue-resolve.sh` (and matching `.claude` copies) to thin clients that register workflow-run / issue-state watches via `sdlc-workflow daemon` and print status, following the pr-approve-watch pattern — no sleep/poll loops, no AGENT_LOOP_WAKE bash sentinels as the load-bearing path. Keep operator-facing arm/classify UX where practical; drop auto-dispatch of deploys from the skill if that would reintroduce domain hardcoding — daemon watches outcomes only. Add thin-client parity tests (no long-lived poll; .cursor/.claude content-identical). Update CHANGELOG.md. Bash continuity retirement stays Phase 2; this task finishes the three session-mortal watcher scripts.

### Acceptance criteria

- [ ] test: deploy-verify-watch and issue-resolve-watch scripts contain no long-lived polling loop; they register the appropriate daemon watch kind and exit
- [ ] test: the .cursor and .claude template copies of each converted skill are content-identical after the change
- [ ] test: across pr-approve-watch, deploy-verify-watch, and issue-resolve-watch templates, no session-mortal GitHub poll loop remains
- [ ] agent: arming the thin deploy-verify client against a test workflow-run target and completing that run produces a consumed wake through the daemon path with no watcher process surviving the arming session

## Task T-08: Scheduled coverage digest over daemon status

- **Story:** S-01
- **Complexity:** M
- **Depends on:** [T-01, T-02, T-03]

Add `sdlc-workflow/src/services/coverage-digest.service.ts` (+ tests) invoked on a daemon schedule (cadence from DaemonConfig / defaultPollSeconds ceiling) that materializes a durable, machine-readable coverage digest from DaemonStatusService: every active watch (kind, target, age, lastPoll), pending/consumed wakes, degraded/poll-error watches, and unwatched known targets. Persist under the per-workspace daemon state dir and expose via `sdlc-workflow daemon status` (or a dedicated flag) without requiring chat. Optional GitHub digest comment may be best-effort only and must use activate-script identity with no hardcoded repos. Document operator check-in in sdlc-workflow docs/CHANGELOG.

### Acceptance criteria

- [ ] test: after a digest tick, the persisted coverage digest lists every active watch with kind, target, age, and lastPoll and every pending/consumed wake for that workspace
- [ ] test: an unwatched PR or run from known-watch-target appears as unwatched in the digest rather than being omitted
- [ ] test: digest generation for workspace A never includes watches or wakes from workspace B
- [ ] agent: `sdlc-workflow daemon status` (or the digest flag) on a live daemon with mixed watched and unwatched targets answers what is watched and pending without an open chat session
