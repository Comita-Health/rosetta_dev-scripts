---
id: SPEC-PRD-0020-P1
prd: PRD-0020
phase: 1
status: Approved # Draft | Approved | Done | Superseded
date: 2026-08-04
owner: Russ Watson
envelope:
  allowedPaths: ['sdlc-workflow/**', 'team-setup/templates/root/.cursor/skills/pr-approve-watch/**', 'team-setup/templates/root/.claude/skills/pr-approve-watch/**', 'CHANGELOG.md']
  forbiddenSurfaces: ['ci-config', 'personal-queue-schema']
  maxDiffLines: 2500
  budgetK: 200
---

# SPEC-PRD-0020-P1: Phase 1 of PRD-0020 delivers the daemon core: a per-workspace, workspace-agnostic long-running process under launchd with a durable file-based watch registry and unified wake inbox, a GitHub poller covering the `pr-review` and `pr-checks` watch kinds with exactly-once wake delivery, an atomic wake-consumption path with chat notification as a best-effort mirror, a structured `sdlc-workflow daemon status` surface, and absorption of the pr-approve watcher skill into a thin register/status client.

## Context

PRD-0020 introduces a background daemon so SDLC signals are captured and acted on even when no chat session is open. Phase 1 builds only the foundation defined by the PRD's rollout plan: process lifecycle under launchd (`daemon install` / `daemon uninstall`), durable per-workspace storage for watches and wakes following the PRD's one-file-per-record contract, the poll/consume pipeline covering the `pr-review` (approve, request-changes, review comment) and `pr-checks` (CI terminal state) watch kinds with exactly-once delivery, the operator-facing `daemon status` command, and the conversion of the session-mortal `pr-approve-watch` bash poll loop into a thin client of the daemon. Continuity fold-in (supervisor relaunch, stale-agent kill, blocker-close resume, retirement of the bash continuity daemon, loud-failure semantics) is Phase 2; the remaining watch kinds and headless action dispatch are Phase 3 — none of that lands here. Phase 1 must not introduce any hardcoded organization/repo/path/domain logic: one daemon instance per workspace, configured only by a declared workspace root, must behave identically for any workspace. The daemon follows the engine's Handler / Service / Repository + InversifyJS architecture inside the `sdlc-workflow` package.

## Task T-01: Per-workspace daemon process skeleton with launchd install and workspace-root-only configuration

- **Story:** S-05
- **Complexity:** M
- **Depends on:** []

Build the long-running daemon entrypoint (a `daemon` subcommand of the `sdlc-workflow` CLI) as a single process whose only required input is a workspace root path; all paths, org/repo identifiers, and behavior must be derived from files discovered under that root (the `DaemonConfig` contract in PRD-0020 §4) rather than compiled-in constants. Add `daemon install` / `daemon uninstall` subcommands that generate and load (or unload) a launchd plist per workspace with KeepAlive=true and a workspace-unique label so two workspaces never share a process, PID file, or log path. This task is process bootstrap and lifecycle (start/stop/exit-code) only, no watch/poll logic.

### Acceptance criteria

- [ ] test: starting the daemon with two different workspace roots produces two processes with distinct PID files and log paths, verified by an integration test spawning both.
- [ ] test: the daemon configuration loader rejects any hardcoded organization, repository, path, or domain-specific literal in source, enforced by a lint/grep-based test over the daemon config module.
- [ ] agent: `daemon install` for a workspace produces a launchd plist with a KeepAlive=true entry and a workspace-unique label, inspected via `launchctl print` or a plist diff.
- [ ] test: launching the daemon without a workspace root argument fails fast with a non-zero exit code and no partial state written.

## Task T-02: Durable file-based storage for watch registry and wake inbox

- **Story:** S-01
- **Complexity:** M
- **Depends on:** [T-01]

Implement the PRD §4 storage contract: one durable file per watch registration and one file per wake event, under a per-workspace directory derived from the workspace root, so state survives process restarts and machine reboots with no external service dependency. Wake IDs are idempotent (kind + target + signal) so a re-detected event maps to the same record, and wake consumption claims use atomic rename so a wake can be claimed exactly once. The existing durable wake inbox layout is absorbed as this store's wake side rather than a second parallel inbox.

### Acceptance criteria

- [ ] test: writing a watch and a wake, killing the process, and reopening the store returns identical records with no data loss.
- [ ] test: two workspace roots produce two physically distinct storage directories with no shared records.
- [ ] test: writing a wake whose idempotent ID (kind + target + signal) already exists does not create a second record.
- [ ] test: two concurrent consumption claims for the same wake result in exactly one winner, enforced by the atomic-rename claim.

## Task T-03: Watch registry lifecycle API scoped per workspace

- **Story:** S-01
- **Complexity:** M
- **Depends on:** [T-02]

Expose an internal API, used by the CLI and poll loop, to register a watch for a target with a kind, poll cadence, optional follow-up action, creator, and optional expiry, per the `WatchRegistration` contract in PRD-0020 §4. Registration must not reference or depend on any in-memory chat/session object so it naturally survives session end. Watches whose targets reach a terminal state auto-expire rather than being polled forever.

### Acceptance criteria

- [ ] test: a watch registered via the API remains queryable after the registering process exits and the daemon is queried fresh.
- [ ] test: registering the same target and kind twice does not create duplicate watch records.
- [ ] test: a watch registered in workspace A is not returned by any list or query call scoped to workspace B.
- [ ] test: a watch whose target reaches a terminal state (e.g. PR merged or closed) is expired by the registry rather than polled indefinitely.
- [ ] agent: listing watches through the registry API returns kind, target, age, and last-poll-time fields for each active watch.

## Task T-04: Poll scheduler with exactly-once dedupe and bounded retry

- **Story:** S-01
- **Complexity:** L
- **Depends on:** [T-02, T-03]

Implement the tick loop that iterates active watches and invokes their source adapters (T-05) on each watch's declared cadence, using T-02's idempotent wake IDs plus an in-flight lease per watch to guarantee a detected signal is committed exactly once even under retried or overlapping polls. Cap consecutive per-watch failures: a watch exceeding the cap is marked degraded (visible in T-07's status output) and stops being retried inline, rather than looping forever. The full loud-failure signaling layer is Phase 2; this phase only requires the bounded cap and the visible degraded state.

### Acceptance criteria

- [ ] test: simulating two overlapping ticks for the same watch and underlying signal produces exactly one wake record.
- [ ] test: retrying a poll after a simulated crash mid-write does not produce a duplicate wake for the same source event.
- [ ] test: a watch whose adapter call fails N consecutive times is marked degraded and stops being retried inline, instead of looping indefinitely.
- [ ] agent: an Approve event on a watched PR is reflected as a wake record within one configured poll interval when checked against the running daemon.

## Task T-05: GitHub signal adapters for the pr-review and pr-checks watch kinds

- **Story:** S-01
- **Complexity:** L
- **Depends on:** [T-04]

Implement one adapter interface with two concrete adapters for Phase 1: `pr-review` (normalizing Approve, Request-changes, and new review-comment events into distinct signals) and `pr-checks` (normalizing CI check-run and status-context terminal states). Both write through the shared wake-inbox path from T-04 — no signal gets a bespoke delivery mechanism. GitHub calls run under the workspace's Addi activate-script identity with token refresh, and use per-target dedup keys. The remaining watch kinds (`issue-state`, `workflow-run`, `run-supervisor`, `queue-item`) are Phase 3 and must not be stubbed in here.

### Acceptance criteria

- [ ] test: the pr-review adapter emits distinct normalized signals for Approve, Request-changes, and new review comments through the shared write path.
- [ ] test: the pr-checks adapter emits a normalized signal for a CI terminal state (success or failure) through the shared write path.
- [ ] test: an adapter cannot write to the wake store via any code path other than the shared inbox writer, enforced by a module-boundary test.
- [ ] agent: an Approve and a CI terminal-state change on watched targets both appear in the wake inbox using the same field schema.

## Task T-06: Wake consumption engine and action-dispatch scaffold

- **Story:** S-03
- **Complexity:** M
- **Depends on:** [T-05]

Build the consumer side of the inbox: a loop that claims pending wakes via T-02's atomic-rename claim, records the consumer in the wake's `consumedBy` field, and invokes a registered follow-up action interface. In Phase 1 the only concrete action is best-effort chat/desktop notification (the existing mirror channels); the interface must be shaped so Phase 3's headless agent dispatch can plug in without rework, but no headless dispatch is implemented here. Notification failure must never block or gate wake consumption.

### Acceptance criteria

- [ ] test: claiming a wake for consumption is atomic such that two concurrent consumers cannot both claim the same wake.
- [ ] test: a consumed wake records its consumer in the `consumedBy` field.
- [ ] test: a failing notification channel does not prevent the wake from being marked consumed, and the failure is recorded rather than silently swallowed.
- [ ] test: the action interface accepts a registered action without any chat or conversation object constructed or passed to it.

## Task T-07: `sdlc-workflow daemon status` structured CLI command

- **Story:** S-02
- **Complexity:** M
- **Depends on:** [T-03, T-06]

Add a CLI subcommand that queries the watch registry (T-03) and wake inbox (T-02) and renders both a human table and a machine-readable JSON form behind a flag. Include an explicit `unwatched` section by diffing known PRs/runs against the active watch set rather than only listing what has a watch, and surface degraded watches (T-04) distinctly.

### Acceptance criteria

- [ ] test: `sdlc-workflow daemon status --json` output validates against a fixed schema containing watches (kind, target, age, lastPollTime) and wakes (state: pending or consumed).
- [ ] test: a target with no registered watch appears in a distinct `unwatched` section of the output rather than being absent.
- [ ] test: a degraded watch (poll-failure cap exceeded) is visibly distinguished from healthy watches in both the table and JSON output.
- [ ] agent: running `sdlc-workflow daemon status` against a live daemon with at least one active watch and one consumed wake shows both in the rendered output.

## Task T-08: Absorb the pr-approve-watch skill into a thin daemon client

- **Story:** S-01
- **Complexity:** S
- **Depends on:** [T-03, T-07]

Convert the `pr-approve-watch` skill's bash poll loop into a thin client: the skill script registers a `pr-review` watch with the daemon and reads `daemon status` (or the wake inbox) instead of running its own long-lived polling process. Update both the `.cursor` and `.claude` template copies in team-setup so consumer workspaces receive the thin client on next sync. The skill's operator-facing contract (arm a watch, wake on Approve or Request-changes) is unchanged; only the transport moves into the daemon.

### Acceptance criteria

- [ ] test: the updated skill script contains no long-lived polling loop; it registers a watch via the daemon and exits.
- [ ] test: the `.cursor` and `.claude` template copies of the skill are content-identical after the change, enforced by a comparison test or sync check.
- [ ] agent: arming the updated skill against a test PR and approving that PR produces a consumed wake through the daemon path, with no watcher process surviving the arming session.
