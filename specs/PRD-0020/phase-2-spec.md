---
id: SPEC-PRD-0020-P2
prd: PRD-0020
phase: 2
status: Approved # Draft | Approved | Done | Superseded
date: 2026-08-10
owner: Russ Watson
envelope:
  allowedPaths: ["sdlc-workflow/**", "team-setup/templates/root/scripts/**", "CHANGELOG.md"]
  forbiddenSurfaces: ["ci-config", "personal-queue-schema"]
  maxDiffLines: 2500
  budgetK: 250
---

# SPEC-PRD-0020-P2: Phase 2 of PRD-0020 folds continuity into the per-workspace TypeScript daemon: dead-supervisor relaunch, per-run stale-agent kill, blocker-close wake, and abandoned-run flagging as modules that share the engine's state readers and the durable wake inbox; retires the bash continuity daemon and its launchd entry; and makes poll and process failure modes loud via KeepAlive plus operator-visible wakes after bounded retries.

## Context

Phase 1 delivered the launchd-managed daemon core, durable watch registry and unified wake inbox, pr-review/pr-checks polling, atomic wake consumption with best-effort notify, daemon status, and the thin pr-approve-watch client. Phase 2 (Continuity fold-in) replaces sdlc-continuity-daemon.sh behaviors with Inversify modules inside sdlc-workflow that read launch.json, state.json, heartbeat.jsonl, supervise.pid, and engine blocker/resume helpers — never re-implementing that logic in shell — and emit every continuity signal through the same wake ledger used for GitHub watches. Issue-state watches and EngineResumeWakeAction already cover remote blocker-close/out-of-band merge resume; this phase must route continuity through those shared readers/actions rather than the bash gh/python scrape path, and must cut over so the old com.rosetta.sdlc-daemon StartInterval job cannot double-relaunch alongside the KeepAlive daemon. Headless agent-dispatch (story S-02) and retirement of the remaining session-mortal deploy-verify / issue-resolve watcher scripts remain Phase 3; this phase must not implement agent -p dispatch, deploys, or Draft→Approved. Workspace-agnostic DaemonConfig rules from Phase 1 still apply: zero hardcoded orgs, repos, consumer paths, or domain rules.

## Task T-01: Continuity tick module with dead-supervisor relaunch

- **Story:** S-03
- **Complexity:** L
- **Depends on:** []

Add a ContinuityService (new `sdlc-workflow/src/services/continuity.service.ts`, tests in `sdlc-workflow/src/__tests__/continuity.service.test.ts`) invoked each daemon tick for the workspace runsDir from DaemonConfig. Detect unfinished runs with a dead supervise.pid via ProcessDetachRepository.isAlive and engine finish predicates in `run-completion.ts` / RunStateRepository — do not copy bash run_is_finished. Relaunch only when launch.json is usable, blockers are not unresolved, and the run is not abandoned; spawn through ProcessDetachRepository + launch-record argv/execArgv replay under RunLockRepository so dual relaunch is impossible. Append relaunch evidence to the run monitor/supervise log and commit a supervisor-dead/restarted wake through the shared wake writer (commitWatchSignal / WakeInbox path), never a bespoke inbox. Wire the module from daemon lifecycle/index DI; no chat or conversation objects.

### Acceptance criteria

- [x] test: when a fixture unfinished run has a dead supervise.pid and a valid launch.json, one continuity tick relaunches supervise, writes a relaunch line to the run monitor or supervise log, and commits exactly one supervisor-restarted wake via the shared inbox writer
- [x] test: a finished run (all tasks merged per engine run-completion predicates) or a run with unresolved needs-human blockers is never relaunched
- [x] test: continuity tick constructs no chat or conversation object and performs no deploy or Draft→Approved transition
- [x] agent: killing a detached run supervisor mid-wave against a live daemon produces an automatic relaunch within one daemon tick with the relaunch recorded in the run monitor log and a wake present in the workspace inbox

## Task T-02: Per-run stale-agent kill continuity module

- **Story:** S-03
- **Complexity:** M
- **Depends on:** [T-01]

Implement stale-agent detection as a ContinuityService submodule or sibling `sdlc-workflow/src/services/stale-agent.service.ts` (tests alongside continuity). Read heartbeat.jsonl and run identity from the engine's own artifacts; kill only processes attributable to that runId (no machine-global pgrep of unrelated agents). Emit a single idempotent agent-stalled wake on the shared inbox; re-arm when the heartbeat recovers so a later stall notifies again. Thresholds come from DaemonConfig / env overrides, not hardcoded consumer paths.

### Acceptance criteria

- [x] test: an implementation heartbeat older than the stall threshold for a given runId causes exactly one kill attempt scoped to that runId and exactly one agent-stalled wake
- [x] test: a healthy or non-implementation heartbeat does not kill any process and does not emit a wake
- [x] test: after a stall wake is emitted, repeated ticks do not re-kill or re-emit until the heartbeat recovers and a new stall occurs

## Task T-03: Abandoned-run flagging and blocker-close wake via engine readers

- **Story:** S-03
- **Complexity:** M
- **Depends on:** [T-01]

Port abandoned-run and blocker-clear detection out of bash into the continuity tick using RunStateRepository mtime/idle, engine blockers/resumable reporting, and the existing issue-state + EngineResumeWakeAction path (`issue-state-watch-source.adapter.ts`, `engine-resume-wake.action.ts`) rather than shelling out to gh/python. Abandoned runs (dead supervisor + idle beyond threshold) emit one wake and must not relaunch. Blocker-close must surface as a wake on the same durable inbox and may resume only through registered wake actions — continuity itself does not become a second resume engine. Update `sdlc-workflow/docs/operator-background-supervise.md` so operators no longer treat the bash daemon as the safety net.

### Acceptance criteria

- [x] test: a dead-supervisor unfinished run idle beyond the abandoned threshold emits exactly one abandoned wake and is not relaunched
- [x] test: when engine blockers report resumable after needs-human issues close, a blocker-cleared or closed wake is committed on the shared inbox path used by GitHub watches
- [x] test: continuity abandoned/blocker modules call engine state readers / EngineResumeWakeAction rather than duplicating sdlc-continuity-daemon.sh shell logic, enforced by a module-boundary or source-contract test
- [x] test: continuity modules watch run/blocker outcomes only and expose no API that performs deploys or Draft→Approved

## Task T-04: Loud-failure semantics for poll errors and process exits

- **Story:** S-01
- **Complexity:** M
- **Depends on:** []

Extend PollSchedulerService / wake commit so a watch that exceeds the Phase-1 consecutive-failure cap also emits an operator-visible degraded/poll-error wake (idempotent per watch+reason) instead of only flipping degradedAt. Fatal daemon bootstrap and unrecoverable tick errors must exit non-zero so launchd KeepAlive restarts the process; success paths remain the only exit 0. KeepAlive itself stays launchd-owned (LaunchdRepository from Phase 1) — do not add an in-process keepalive. Cover with tests under `sdlc-workflow/src/__tests__/`.

### Acceptance criteria

- [x] test: after the configured consecutive poll-failure cap, the scheduler commits an operator-visible poll-error wake for that watch and does not exit 0 from the failure path
- [x] test: re-failing the same degraded watch does not create duplicate poll-error wakes for the same watch and reason
- [x] test: simulated fatal daemon startup or unrecoverable tick failure returns a non-zero process exit code
- [x] agent: daemon status on a workspace with a force-failed adapter shows the watch as degraded and a corresponding poll-error wake in pending or consumed

## Task T-05: Retire bash continuity daemon and cut over launchd

- **Story:** S-01
- **Complexity:** M
- **Depends on:** [T-01, T-02, T-03, T-04]

Retire `team-setup/templates/root/scripts/sdlc-continuity-daemon.sh` and `install-continuity-daemon.sh` (delete or replace with fail-loud stubs that print migration to `sdlc-workflow daemon install` and exit non-zero). Extend daemon install/uninstall so enabling the per-workspace KeepAlive plist unloads/removes the legacy `com.rosetta.sdlc-daemon` StartInterval agent first, preventing dual relaunch during migration. Document the cutover in CHANGELOG.md and operator docs under sdlc-workflow. Remaining session-mortal deploy-verify-watch and issue-resolve-watch scripts stay until Phase 3.

### Acceptance criteria

- [x] test: the retired continuity install/daemon scripts no longer schedule a StartInterval relaunch loop (absent or exit non-zero with migration guidance; no live tick implementation remains)
- [x] test: daemon install for a workspace unloads or removes a fixture legacy com.rosetta.sdlc-daemon plist before loading the per-workspace KeepAlive agent
- [x] test: with the TypeScript continuity modules armed, a dead supervisor is relaunched by the per-workspace daemon path without invoking sdlc-continuity-daemon.sh
- [x] agent: after cutover on a scratch workspace, launchctl shows the per-workspace daemon label loaded with KeepAlive and no active com.rosetta.sdlc-daemon job
