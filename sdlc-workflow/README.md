# sdlc-workflow

PRD-0011 (Full-Loop SDLC Automation):

- **Phase 1** (`decompose`, [SPEC-PRD-0011-P1](../specs/PRD-0011/phase-1-spec.md)):
  decompose a PRD into product stories, synthesize an
  [ADR-0008](https://github.com/Rosetta-Foundation/rosetta_docs/blob/main/architecture/ADR-0008-implementation-spec-format.md)
  implementation spec with a blast-radius envelope, write it to the target
  repo as `Draft`, and stop at the human gate.
- **Phase 2** (`run`, [SPEC-PRD-0011-P2](../specs/PRD-0011/phase-2-spec.md),
  done): execute one ready task from an Approved spec in an isolated
  worktree, run machine gates in **shadow mode** (verdicts recorded, never
  enforced), and halt — human approval is the only advance mechanism.
- **Phase 3** ([SPEC-PRD-0011-P3](../specs/PRD-0011/phase-3-spec.md),
  done — live-validated 2026-08-01, run `p3-live-val` auto-merged
  [PR #32](https://github.com/Rosetta-Foundation/rosetta_dev-scripts/pull/32)):
  parallel fan-out across ready tasks, real PR lifecycle with a
  bounded CI fix cycle, gate enforcement with auto-merge on green,
  post-merge sandbox deploy + PRD-0007 digest with veto-triggered revert.
  Landed: the T-01 dependency-ordered task pool; the T-02 PR
  lifecycle — each completed task branch is pushed and gets a real PR
  (idempotent on resume), which is the reviewer- and CI-gate subject;
  the T-03 live CI monitor — checks are polled to terminal and failures
  dispatch a fix agent (at most 3 attempts, persisted across resume)
  before the post-cycle verdict reaches the aggregator; and T-04 gate
  enforcement — every gate green auto-merges the task PR (merge SHA
  recorded in run state and the `sdlc.merge.v1` artifact, attributed to
  `machine-gates`), any red gate blocks with a `merge-blocked`
  escalation, and `--shadow` restores the record-only calibration mode;
  and T-05 phase boundary — once every task has merged, the merged
  default branch deploys to the sandbox (SHA-idempotent, step-cached)
  and the phase digest posts to the PRD-0007 queue with merge links; a
  `[veto]` tag on that item (`check-veto`) reverts the phase merges
  through a PR, redeploys the sandbox at the reverted SHA, and records
  an `sdlc.revert.v1` Chronicle artifact; and T-06 escalation surface —
  each exception trigger posts an `action-required` queue item (task,
  trigger, evidence refs), token spend against `budgetK` halts new agent
  dispatches pool-wide, and `status` categorizes tasks as merged /
  halted-escalated / blocked-by-dependency so a partial failure is
  triageable without opening state files.

## Usage

```bash
cd sdlc-workflow
bun install

# Phase 1: decompose a PRD and write the Draft spec into a target repo
bun run dev -- decompose --prd PRD-0011 --repo ../../rosetta_chronicle

# Options
#   --docs-dir   PRD location (default: ../rosetta_docs/product)
#   --phase      rollout phase to specify (default: 1)
#   --budget-k   token budget in thousands, recorded in the envelope (default: 200)

# Lint a spec file's format before intake (no LLM call, no --repo; hook/CI safe)
bun run dev -- spec-lint --spec ../specs/PRD-0011/phase-2-spec.md

# Execute all ready tasks from an Approved spec (parallel worktrees)
bun run dev -- run --spec ../specs/PRD-0011/phase-3-spec.md --repo .. \
  --chronicle-repo ../../rosetta_chronicle_roustalski

# Options
#   --run-id          stable run identifier; branches are sdlc/<run-id>/<task-id>
#                     (default: <spec-file>-<date>)
#   --runs-dir        run state + worktrees location (default: ~/.rosetta/sdlc-runs)
#   --chronicle-repo  personal Chronicle ledger repo; enables the T-07 queue
#                     digest and T-08 artifact commits (skipped when absent)
#   --max-parallel    concurrent implementation agents per wave (default: 3)
#   --shadow          record gate verdicts but never merge (calibration mode)
#   --heartbeat       emit structured progress every N seconds (default: 30;
#                     0 disables). Also appends <runsDir>/<runId>/heartbeat.jsonl
#   --operator        GitHub login assigned on needs-human escalation issues
#                     (also accepted via SDLC_OPERATOR env; never hardcoded)

# Operator default: detach with --supervise --detach + --heartbeat, then check
# in on wakes — do not block the agent chat on sandbox waits.
# See docs/operator-background-supervise.md (team-setup skill: sdlc-run-supervise).

# Operator default: --supervise --detach + --heartbeat, then check in on
# wakes — do not block the agent chat on sandbox waits.
# See docs/operator-background-supervise.md (team-setup skill: sdlc-run-supervise).

# Record a human-approved merge in the run's Chronicle artifact (T-08);
# --task marks that task merged, which unblocks its dependents (P3 T-01)
bun run dev -- record-merge --run-id <run-id> --sha <merged-sha> \
  --task T-01 --chronicle-repo ../../rosetta_chronicle_roustalski

# After a human vetoes the phase digest ([veto] tag on the queue item),
# revert the phase merges and redeploy the sandbox (P3 T-05)
bun run dev -- check-veto --run-id <run-id> --repo .. \
  --chronicle-repo ../../rosetta_chronicle_roustalski

# Generate or refresh a spec's closeout PR from a run's recorded verdicts —
# checkboxes and status: Done are derived, never authored (SPEC-PRD-0023-P1).
# The phase boundary does this automatically; run it by hand to close out a
# spec that landed before the machinery existed, or after an interruption.
bun run dev -- closeout --run-id <run-id> \
  --spec specs/PRD-0023/phase-1-spec.md --repo ..

# Inspect a run: task results, cached step graph, verdicts, exceptions (T-09)
bun run dev -- status --run-id <run-id>

# Lint an ADR-0008 spec before intake (front-matter parse, envelope schema,
# checkbox integrity) — no LLM call, no --repo; hook/CI safe (#40)
bun run dev -- spec-lint --spec ../specs/BUG-envelope-spec-integrity/phase-1-spec.md

# Queue a spec to launch automatically when the current supervised run
# finishes and this spec is Approved (SPEC-BUG-retro-and-queued-plans-P1 T-02)
bun run dev -- queue-run --spec ../specs/PRD-0011/phase-4-spec.md --repo ..

# List queued launch records (FIFO, oldest first)
bun run dev -- status --queue

# Per-workspace SDLC event daemon (SPEC-PRD-0020-P1 T-01/T-04/T-06) — process
# bootstrap, durable storage, watch registry, bounded poll scheduler, and the
# wake consumption loop (atomic claim → consumedBy → registered actions).
# The scheduler polls pr-review / pr-checks / issue-state; consumption runs
# notify (chat/desktop) plus engine-resume (blocker-close / out-of-band merge
# → record-merge + relaunch from launch.json). Full Phase 3 headless agent
# dispatch remains on the same action interface.
# Config is `.sdlc/daemon.json` under the workspace root (DaemonConfig contract).
# Optional `operator` (GitHub login) is written into the launchd plist as
# `SDLC_OPERATOR` so KeepAlive restarts and future headless/continuity children
# inherit your assignee. Interactive `run` still honors `--operator` / shell
# `SDLC_OPERATOR` — put `export SDLC_OPERATOR=YourLogin` in ~/.zshrc for CLIs
# started outside launchd.
# `install` creates `.sdlc/daemon/` + touches the log before launchd load;
# load is transactional (enable failure → bootout + plist remove);
# install/uninstall unload+remove legacy `com.rosetta.sdlc-daemon` first
# (retired bash StartInterval agent — SPEC-PRD-0020-P2 T-05);
# `uninstall` derives the label/plist from the workspace root alone so a
# missing/malformed contract cannot leave an orphaned agent.
bun run dev -- daemon --workspace ../..
bun run dev -- daemon status --workspace ../..
bun run dev -- daemon status --workspace ../.. --json
bun run dev -- daemon watch --workspace ../.. Owner/repo#123
bun run dev -- daemon watch --workspace ../.. --kind pr-review \
  --poll-seconds 30 --created-by pr-approve-watch Owner/repo#123
# Prefer the compiled entry for install (launchd runs plain node).
# `bun run dev -- daemon install` remaps src/*.ts → dist/index.js when present.
bun run build && node dist/index.js daemon install --workspace ../..
bun run dev -- daemon uninstall --workspace ../..
# Cut over stranded session wakes (~/.rosetta/wake/pending) into the daemon
# ledger. Default --disposition auto claims historical pr_approve wakes as
# consumed (no notify storm) and leaves escalations/supervisor exits pending
# for the KeepAlive consumer to drain.
node dist/index.js daemon migrate-wake --workspace ../..
node dist/index.js daemon migrate-wake --workspace ../.. --dry-run
# Options
#   --workspace   required workspace root (all paths/ids derived from it)
#   --json        machine-readable status / watch-registration output
#   --kind        `daemon watch` kind: pr-review (default), pr-checks, or issue-state —
#                 the only kinds whose targets are owner/repo#N
#   --poll-seconds  override cadence (default: workspace defaultPollSeconds)
#   --created-by  registration attribution (default: cli)
#   --plist-dir   LaunchAgents directory (default: ~/Library/LaunchAgents)
#   --no-load     write the plist without calling launchctl (tests / dry-run)
#   --from        legacy wake root (default: $ROSETTA_WAKE_DIR / ~/.rosetta/wake)
#   --disposition auto | pending | consumed (migrate-wake; default auto)
#   --dry-run     migrate-wake: map only, do not write or archive
```

The daemon store derives its root from the workspace exactly as lifecycle
does: `.sdlc/daemon/`. Watch registrations are independent JSON files under
`watches/`. Wake events keep the existing inbox shape — `wake/pending/`, moved
to `wake/consumed/` when claimed — on top of a `wake/records/` ledger:

```text
wake/records/<wakeId>.json    written once per wake ID, never removed
wake/pending/<wakeId>.json    hard link to the ledger entry: unclaimed
wake/consumed/<wakeId>.json   that same link, renamed by the winning claim
```

A wake ID is the SHA-256 digest of its `(kind, target, signal)` tuple, so
detecting one signal again resolves to the original record. The ledger entry
is created with `link(2)`, which fails rather than clobbers, making it a
permanent atomic "has this ever been published" gate; only the writer that
wins it links the wake into `wake/pending/`. A pending link therefore exists at
most once per ID, so the `rename(2)` that claims it can succeed at most once —
a re-detected signal cannot resurrect a claimed wake, and a claim can never
replace an existing consumed record. Content and directory entries are fsynced
before a write is reported, so records survive a kill or a reboot with no
database, broker, or live session.

`WatchRegistryService` is the internal registration and poll-loop API over
that store. A watch ID is derived from its kind and normalized structured
target, so registering the same target and kind is idempotent. Every call is
scoped by workspace root; registrations contain only durable values from the
PRD-0020 `WatchRegistration` contract and no chat/session references. `list`
returns active watches with `kind`, `target`, age in whole seconds,
`lastPollTime`, consecutive failures, and degraded state. A declared expiry or
a terminal result passed to `recordPoll`
durably expires the record and removes it from subsequent active queries while
retaining it on disk for audit.

`PollSchedulerService` starts with the daemon and evaluates each active watch
on its own declared cadence: the interval between ticks is the shortest
`pollSeconds` among active watches, so `defaultPollSeconds` from
`.sdlc/daemon.json` is the _idle ceiling_ rather than the tick, and a watch that
asks to be polled faster than the default gets it.

`ContinuityService` (SPEC-PRD-0020-P2 T-01 / T-03) starts on the same cadence and
scans `DaemonConfig.runsDir` for unfinished runs whose `supervise.pid` is dead.
When `launch.json` is usable, needs-human blockers are not unresolved, and the
run is not abandoned, it relaunches under `RunLockRepository` via
`ProcessDetachRepository`, appends a monitor/supervise log line, and commits a
`supervisor-restarted` wake through `commitWatchSignal`. Abandoned idle runs
(`RunStateRepository.idleSeconds` beyond `SDLC_ABANDONED_SECONDS`) emit one
`abandoned` wake and are not relaunched. When `BlockerService` reports
`resumable` after needs-human issues close, a `closed` wake is committed on the
shared `issue-state` inbox path for `EngineResumeWakeAction` — continuity does
not relaunch that path itself.

`StaleAgentService` (SPEC-PRD-0020-P2 T-02) runs on the same continuity tick.
It skips finished runs (`allTasksMerged`) and runs without usable `state.json`
before inspecting heartbeats — matching bash continuity's
`run_is_finished` / present-state gate. For unfinished runs it reads each
engine `heartbeat.jsonl`: an in-flight `implementation` snapshot quieter than
`SDLC_AGENT_STALL_SECONDS` (default 2400) triggers exactly one kill attempt
whose process filter includes that `runId` (never a bare machine-global agent
kill) and exactly one `agent-stalled` wake on the shared inbox. Wake signal ids
are episode-keyed so a recovered heartbeat re-arms a later stall notification.

An exclusive, expiring lease keeps overlapping ticks off the same watch. Leases
live at `poll-leases/<sha256(watchId)>.<generation>.json`, and taking one means
exclusively creating the generation after the highest one on disk. Recovering a
lease abandoned by a crashed poll therefore _adds_ a generation instead of
removing the expired file, so no code path unlinks a lease it does not own and
two concurrent recoveries cannot both end up holding the watch. A release only
removes its own generation _and_ token, so a late completion can never drop a
successor's lease.

Adapter signals are committed through the durable wake ledger before poll
success is recorded, so a retry after interruption resolves to the original wake
ID. Adapter failures are recorded per watch; after three consecutive failures
the watch remains visible as degraded, an operator-visible `poll-error` wake is
committed (idempotent per watch+reason via `commitPollErrorWake`), and the
watch is skipped by subsequent ticks. Unrecoverable top-level tick errors and
fatal daemon bootstrap exit non-zero so launchd KeepAlive restarts the
process; success (clean SIGTERM/SIGINT shutdown) is the only exit 0. KeepAlive
itself stays launchd-owned — the daemon does not arm an in-process restart
loop.

A watch whose kind has no registered source adapter is _skipped, not failed_ — a
missing adapter is a wiring gap, not a signal-source fault, so it neither
consumes the watch's failure budget nor degrades it. While the adapter registry
is empty the loop does no polling work at all: it logs that once and keeps its
timer. The process registers GitHub `pr-review`, `pr-checks`, and `issue-state`
source adapters into `WatchSourceAdapterRegistry` at start: `pr-review`
normalizes Approve, Request-changes, new inline review comments, and a
`merged` signal (with merge commit OID) before terminal expire; `pr-checks`
normalizes Checks API and commit status-context terminal success/failure for
the PR head SHA; `issue-state` emits `closed` when a needs-human blocker
issue closes. `pr-checks` reads the individual commit status contexts rather
than the combined rollup, because the combined `pending` state means "no
statuses **or** a context is pending" — trusting the rollup would wedge every
Checks-API-only PR (any repo on GitHub Actions), which reports `pending` with
no contexts forever. All pages of check runs are fetched before a verdict is
taken, so a busy commit cannot be called green off an incomplete first page.
Adapters call GitHub under the workspace daemon contract's Addi activate
script (with token refresh) and return signals only — the scheduler commits
them through the shared wake-inbox writer (`commitWatchSignal`), which also
merges watch `resumeContext` into wake `data` so resume actions see `runId` /
`taskId`. Remaining watch kinds (`workflow-run`, `run-supervisor`,
`queue-item`) stay unregistered until Phase 3.

`WakeConsumptionService` is the consumer side of that inbox. It lists
`wake/pending/`, claims each wake with the store's atomic rename (exactly one
winner under concurrency), stamps `consumedBy` onto the shared ledger inode,
then invokes every action registered in `WakeActionRegistry`. Registered
actions include `notify` (desktop / chat-mirror) and `engine-resume`: on
`closed` / `merged` wakes that carry `runId`, it record-merges when needed and
relaunches `--supervise` from the run's `launch.json` (no-op when the
supervisor pid is still alive). A channel/action failure is appended to the
wake's `actionFailures` and never moves the wake back to pending. The action
context is `{ workspaceRoot, wake, consumedBy }` with no chat/conversation/
session object, so Phase 3 headless agent dispatch can register beside these
without reshaping the loop.

`--supervise` / `--detach` persist `<runsDir>/<runId>/launch.json` (argv,
execArgv, execPath, cwd, repoPath, specPath) so continuity and
`engine-resume` can relaunch without a chat session. Escalation posts also
register `issue-state` (+ `pr-review` when a PR URL is known) watches with
`resumeContext` so remote blocker-close / out-of-band merge can unstick a run.

`daemon status` (SPEC-PRD-0020-P1 T-07) is the operator coverage surface over
that store. It lists every active watch (`kind`, `target`, `age`,
`lastPollTime`, plus an explicit `degraded` flag when the poll-failure cap
has been exceeded), every pending and consumed wake (`state: pending |
consumed`), and an `unwatched` section produced by diffing engine-known PRs
and runs (task `prUrl`s and run directories under the workspace `runsDir`, plus
queued launches) against the active watch set — so a known target with no
registration is visible rather than absent. `--json` emits the same report
as a single object validated by a fixed schema.

`daemon watch` (SPEC-PRD-0020-P1 T-08) is the register-and-exit CLI used by
the thin `pr-approve-watch` skill client. It writes durable `pr-review`
registrations through `WatchRegistryService` and returns — the long-lived
daemon keeps polling. Re-registering an active kind+target is idempotent.
`--kind` accepts `pr-review`, `pr-checks`, and `issue-state`: every target on
this command is parsed as `owner/repo#N`, which the run-id kinds cannot
express.

`decompose` grounds the synthesized envelope in the target repo tree (#35):
every `allowedPaths` glob must match at least one existing path in the
`--repo` checkout, or be justified as a new-path intent by a task naming
the file it creates in its engineering notes. Anything else fails synthesis
with `ENVELOPE_UNGROUNDED`, listing the offending globs. A diff-forecast
heuristic also warns (without blocking) when a task's engineering notes
reference a path no `allowedPaths` glob covers, so the human reviews a
coherent envelope instead of discovering the gap as a mid-run breach.

`decompose` hard-stops after writing the Draft spec. Approval is a
`status: Draft → Approved` flip in a dedicated commit (ADR-0008) —
`run` refuses anything but an Approved spec, records the refusal as a
blocked verdict in `state.json`, and exits non-zero. A launch record
(`state.json` with run id, spec digest, base SHA, argv, `startedAt`, empty
steps) is written at invocation start — before intake — so a crash never
leaves `status` answering `RUN_NOT_FOUND` (#37). Surface labels fail closed
at synthesis (#36): every synthesized `forbiddenSurfaces` label must resolve
against the target repo's `.sdlc/surfaces.json`, and an unresolvable label
aborts `decompose` with `SURFACE_UNRESOLVABLE` — the label named and the
repo's known labels listed — rather than being silently dropped before a
human reviews the spec. The known labels are also fed into the synthesis
prompt so the model picks from real surfaces. The envelope
gate evaluates the task branch diff against the spec's blast-radius envelope
(forbidden-surface labels resolve via `.sdlc/surfaces.json` read from the
tree under judgment — see the tree-resolution rule below). Since
P3 T-04 the gates enforce by default: green across the board merges the
task PR automatically; any red gate blocks and escalates (`--shadow`
disables enforcement for calibration).

**One ACTION REQUIRED issue per escalate wave.** The phase aggregator may
emit several exception triggers for the same task head (e.g.
`reviewer-disagreement` + `envelope-breach`). Escalation posts **one**
GitHub issue and wake titled
`ACTION REQUIRED: SDLC <runId> <taskId>` with every trigger listed in the
body — not one issue per trigger (Comita-Health/rosetta_dev-scripts#92 /
#93). When the aggregator already filed that wave, enforcement still
records `merge-blocked` in the run ledger but does **not** open a second
GitHub issue for the same head. `merge-blocked` issues remain when the
aggregator has nothing to file (for example CI/verification-only red, or
green gates with no recorded PR).

The **sandbox gate is part of that aggregate.** A declared sandbox that
deployed unhealthily blocks the merge, so "it merged" means "it deployed".
A repo with no `.sdlc/environments.json` contract is not a failure — the
absence of a contract is not evidence of a broken deploy — and does not
block.

### Recoverable stops instead of terminal ones (Wave 0)

A postmortem over 23 real runs found **62.7% of elapsed time had no
supervisor process running at all** (1,560 of 2,487 minutes). Almost none of
that was slow work; it was the engine stopping on conditions that were
recoverable and then waiting for a human to relaunch it. Four behaviors
changed:

| Stop                     | Old behavior                                  | Now                                                                              |
| ------------------------ | --------------------------------------------- | -------------------------------------------------------------------------------- |
| CI has no check runs yet | `blocked` on the first poll → escalate → exit | Poll a bounded **appear window** first; absence is a wait, not a verdict         |
| Reviewer disagreement    | terminal                                      | Bounded remediation round, then escalate                                         |
| Envelope breach          | terminal                                      | Bounded remediation round (trim scope — never widen the envelope), then escalate |
| `merge-blocked`          | supervisor exits                              | Bounded retry with backoff, invalidating the `ci` and phase steps                |

**CI appear window.** Every CI block in the entire corpus — all 16 of 59
verdicts — read `no check runs` or `no CI results for <sha>`. There were
**zero actual CI failures**, because the engine pushed and polled before
GitHub had registered the check runs. The gate now distinguishes three
states: not yet reported (keep waiting, up to `checksAppearTimeoutMs`),
reported and failing (the existing bounded fix loop), and appear-deadline
exceeded (escalate — a check suite that never registers is a real
misconfiguration, not something to spin on).

**Gate remediation.** Reviewer disagreement and envelope breach were 22 of
44 historical escalations, and each one ended its run cold — even though
median reviewer dispatch is only 1.16 minutes, so re-judging is cheap. A red
reviewer or envelope gate now re-dispatches the implementation agent in the
task's existing worktree with the failing verdicts' reasons as input,
commits and pushes the fix, and lets the gates judge the new head. The
budget is explicit (`gateFixAttempts` per task in `state.json`, default 2)
and exhaustion escalates loudly rather than spinning. Envelope remediation
is instructed to **reduce the diff**, never to raise `maxDiffLines` — a gate
that negotiates its own threshold is not a gate. Each round is recorded in
`state.remediations` and a `[remediate] <task> …` line in `monitor.log`.
After remediable remediation exhausts, Phase 1 (PRD-0025) dispatches a
separate headless operator-unstick turn (`OperatorUnstickService`, wired
from `run.handler` `remediationRound` — no chat/session) whose prompt
(`utils/operator-unstick-prompt.ts`) mandates rebase/integration tip,
out-of-band merge + `record-merge`, and resume via existing engine CLIs —
not gate-remediation trim-the-diff. Cleared / risky-proceed suppress
blocking ACTION REQUIRED for that wave; abstain / exhaust /
authority-bound keep the escalate + issue-state resume path. `cleared`
requires blocker-clear evidence (record-merge / `mergedSha`, cleared marker
plus tip HEAD move, or cleared plus resume) — not a bare marker or HEAD
move alone — and committed mid-run `specs/**` / envelope-limit rewrites
route to abstain even when the worktree is clean. Budget lives in
`operatorUnstickAttempts`, outcomes in `operatorUnstickOutcomes`, status
tiers in `escalateTiers` — durable across resume so the unstick budget
cannot refill.

**Merge-blocked retry.** The supervisor exited on `merge-blocked` 28 times
across 79 waves, each ending the process. It now retries up to
`MERGE_BLOCKED_RETRY_LIMIT` times with backoff, invalidating the step-cache
entries that could produce a different answer (`ci` and the phase
aggregate). Retries are counted in `state.mergeBlockedRetries`, and
exhaustion is still a loud terminal exit.

**Out-of-band merge reconcile (#79).** A red phase never used to ask GitHub
whether the task PR already landed. When GHA **Addi merge on Approve** (or a
human `gh pr merge`) merges the PR while the engine is still merge-blocked,
supervise retried the same cached red verdict, exhausted the budget, and
left dependents without a `mergedSha` — stalling `queue-run` until a manual
`record-merge`. The red-phase path now calls `mergeCommitOid` before
recording merge-blocked; a confirmed MERGED PR records `mergedSha` (Chronicle
`approvedBy: out-of-band`) and continues the wave. Any `recordTaskMerged`
(engine or `record-merge --task`) also zeros `mergeBlockedRetries` so resume
after an operator unstick does not immediately hit “retries exhausted”.

**Recurring escalations re-notify.** `emitOnce` deduped on the escalation
title alone, so a given escalation woke a human exactly once ever and
recurrence was silently swallowed. Escalations now carry an `occurrenceKey`
(the branch head SHA, or the implementation digest for a task with no head)
folded into the dedupe marker: the same finding on unchanged content stays
quiet, but the same finding after an agent pushed a fix wakes the human
again.

**Instrumentation.** Only `starting`, `implementation` and `reviewer` set a
heartbeat step, so 52.6% of measured work was unobservable and time from the
uninstrumented steps accrued under whatever label was left standing —
overstating reviewer time by roughly 3.5 minutes a segment. `sandbox`,
`verification` (including per-criterion verifier-agent progress), `ci` and
`merge` now set their own labels.

### Crash-safe, single-writer runs (Wave 1)

Wave 0's retry loops are only trustworthy if the state they resume from
survived the last crash, so `state.json` became durable and exclusively
owned (SPEC-PRD-0021-P1):

- **Atomic writes.** Every save goes to a temp file in the same directory,
  `fsync`s, then `rename`s over the target. A reader polling during a write
  sees one complete document or the previous one — never a truncated prefix —
  and a kill mid-write leaves the previous state fully parseable.
- **One writer per run.** `run.lock` in the run directory is taken by
  exclusive file create, so the kernel picks the winner. `run` / `supervise`
  hold it for the whole session; short-lived mutators take a momentary lock
  around their write. A second engine fails immediately with `RUN_LOCK_HELD`
  naming the live pid, host, owner and start time rather than blocking or
  clobbering. A lock whose owner is dead **on this host** is reclaimable —
  otherwise a SIGKILLed run would be permanently unresumable — but a pid
  recorded on another host never is, because it cannot be probed from here.
- **Shared retry policy.** `RetryExecutorService` is the single place the
  attempt cap, the backoff curve (doubling, capped at 30s) and the
  `RecoveryHistory` schema are defined. It re-invokes the caller's step and
  nothing else: it has no reference to a verdict type and no branch that can
  construct or soften one, because a retry layer able to do that would make
  every gate advisory.
- **Non-gate steps retry, gates do not.** PR open, sandbox deploy and
  Chronicle commit are retried through the executor and record their attempt
  trail on the step (`steps[key].recovery`), so a flaky step is visible
  afterwards instead of only in a log. Only a _thrown_ sandbox error retries;
  an unhealthy deploy is a verdict. Recovered steps land in the step cache
  like any other, so a resume reuses them with no hand-edits and no duplicate
  PR, deploy, or ledger commit.
- **Sanitized agent dispatch.** Nested-agent markers (`CURSOR_AGENT`,
  `CLAUDECODE`, the askpass pair, …) are stripped before spawning any agent.
  A child that inherits them can decide it is re-entrant and exit without
  doing the work — a silent no-op indistinguishable from "nothing to change",
  after which every gate judges an unmodified branch. The list is a denylist,
  not a `CURSOR_*` wildcard, because the engine dispatches _with_
  `CURSOR_AGENT_BIN` and `CURSOR_MODEL`. Every dispatch also gets
  `CURSOR_DATA_DIR` pointed at the engine agent-data root
  (`~/.rosetta/agent-data`, or `SDLC_AGENT_DATA_DIR` when set) so engine
  transcripts never enter the operator's `~/.cursor` history; an inherited
  `CURSOR_DATA_DIR` is overridden on purpose. Credentials still resolve from
  `CURSOR_CONFIG_DIR` / the operator's logged-in CLI session. To inspect or
  resume an engine session:
  `CURSOR_DATA_DIR=~/.rosetta/agent-data cursor-agent ls`.
- **Detached launches are verified, not assumed.** The parent used to sample
  child liveness once at 1.5s; on a loaded machine it sampled mid-boot, so it
  printed "detached" and exited 0 for a run that died a second later. It now
  watches for up to 8s and stops early on evidence either way — a _new_
  `supervise.exit` (stale records from a prior supervise of the same runId
  are cleared before spawn), or a dead pid. Failure detail tails only the
  post-spawn bytes of `supervise.log`, so a historical terminal exit is never
  misreported as this child's startup failure (#79).

### Engine branches and target-repo hooks (#41)

Task branches are `sdlc/<run-id>/<task-id>`. If the target repo's husky
pre-commit only allows `f/*` / `b/*`, agent `git commit -s` fails. The
engine therefore:

1. prompts agents to use `git commit --no-verify -s`, and
2. **owns a salvage commit** when the agent exits with a dirty worktree on
   the tip (`git add -A && git commit --no-verify -s`).

Target repos may alternatively allow `sdlc/*` in their branch check; either
path unblocks multi-task runs. CI still validates the PR.

### Spec integrity: `spec-lint` and the single-writer rule (#40)

Two guards protect the spec file itself.

**Single-writer rule.** A product-task diff must never edit anything under
`specs/**` (nor a nested `**/specs/**`) — including flipping its own
acceptance-criteria checkboxes or changing `status:`. The envelope gate
hard-breaches on any spec-tree path even when `allowedPaths` explicitly
covers it: the canonical self-ticking move (an agent closing its own
checkboxes in the same diff that implements the task) is a breach, not a
convenience. Checkbox state and phase `Done` closeout have exactly one
writer — the engine closeout / docs PR after the product tasks merge
(PRD-0023) — so run-time truth can never be forged mid-run.

**`spec-lint`.** `spec-lint --spec <path>` validates an Approved spec's
Markdown without an LLM call or a `--repo`, so it runs from a pre-commit
hook or CI. It layers three named checks and exits non-zero on the first
failing class:

- front-matter / structure parse (`SPEC_MALFORMED` — e.g. a missing
  envelope field),
- envelope schema + inline-array integrity (`SPEC_MALFORMED` for a
  formatter-reshaped array, `SPEC_INVALID` for an empty `allowedPaths` or a
  non-positive `maxDiffLines` / `budgetK`),
- checkbox integrity (`SPEC_INVALID` when a task carries no criteria,
  `SPEC_MALFORMED` when a criterion is missing a recognized verification
  tier — `test:` / `agent:` / `manual:` / `docs:`).

Its reason for existing is the Prettier incident: `prettier --write` on a
`*.md` spec can fold the envelope's inline flow array into a YAML block
sequence that the tolerant parser silently mis-joins into one garbage glob,
after which the envelope guards nothing. `spec-lint` names that reshape
before intake silently accepts it.

### Closeout: checkboxes derived from verdicts (SPEC-PRD-0023-P1)

The single-writer rule above says agents never tick their own criteria. This is
the writer that does. When the last task of a phase merges, the phase boundary
generates a **closeout PR** whose entire diff is derived from `state.json`:

1. `closeout-aggregate.service` reads the run's recorded verdicts and returns
   one record per spec criterion — `pass`, `fail`, `human-required`, or an
   explicit `no-verdict` for criteria the run never judged. Nothing is omitted,
   because a missing entry and an unverified criterion must not look alike.
2. `spec-closeout.ts` applies that map to the spec markdown on the default
   branch: a criterion with a passing verdict is ticked, everything else is
   left alone, and `status: Done` is written **only** when every criterion
   passes, every task merged, and every phase gate is green. Partial coverage
   never downgrades or placeholders the existing status.
3. `closeout.service` commits through `SpecFileRepository.writeCloseout` — the
   one route allowed to overwrite a spec — onto the stable branch
   `sdlc/closeout/<spec-id>`, then opens or **updates in place** the PR for
   that branch. Identity is the branch, not the title, so an interrupted job
   re-run leaves exactly one PR reflecting the latest verdicts.

The PR body is generated too: a table of verified criteria citing
`(task, gate, evidence link)`, a **Remainder** section naming every criterion
the run could not verify and why, and — when the spec arrives with boxes a
human ticked by hand — a section listing them. Closeout **never unticks**: a
hand tick is a human's record of hand verification. It does not count toward
`status: Done` either, so it appears in both lists.

Two consequences elsewhere:

- **A phase is not complete until its closeout PR exists.** `phaseComplete`
  requires all tasks merged _and_ a closeout PR that is open or merged, queried
  live (`utils/run-completion.ts`). "All tasks merged" was what let five specs
  land while still reading `status: Approved`. A closed-unmerged closeout PR, or
  a `gh` failure that leaves the answer unknown, both read as incomplete —
  claiming a phase is done on the strength of a network error is worse than
  making the operator look.
- **The phase Chronicle artifact links the closeout PR** (`closeoutPr` in the
  digest payload), so the docs PR is reachable from the memory record. The
  digest step's cache key includes whether that link was available, so a
  closeout that only succeeds on a later attempt still gets published.

`closeout --run-id <id> --spec <path> --repo <path>` runs the same code by hand
for a spec that landed before this existed. Shadow runs never close out — they
record verdicts without merging, so there is nothing to document.

### Progress heartbeat (#39)

`run --heartbeat <seconds>` (default `30`) prints
`[heartbeat] {json}` lines with `runId`, `taskId`, `step`, `stepElapsedMs`,
`agentAlive`, `worktreeDirty`, `worktreeHead`, and `lastLine`, and appends
the same records to `<runsDir>/<runId>/heartbeat.jsonl`. Pass `--heartbeat 0`
to disable. Prefer `--supervise --detach` for long detached runs (see #38 /
#43 F2 and `docs/operator-background-supervise.md`) — do not rely on IDE
harness backgrounding.

### Detached / supervise exit detection (#38)

A `--supervise` (or detached supervise child) process installs exit traps so
**trappable** terminations — clean return, thrown error, `SIGTERM` /
`SIGINT` — always write:

| Artifact                           | Role                                                    |
| ---------------------------------- | ------------------------------------------------------- |
| `<runsDir>/<runId>/supervise.exit` | JSON `{ code, reason, abnormal, at }`                   |
| `monitor.log` terminal line        | `[supervise] exit code=… reason=… abnormal=…`           |
| Durable wake                       | `sdlc_supervisor` event under `~/.rosetta/wake/pending` |

`abnormal: false` is reserved for legitimate all-tasks-merged completion
(`code: 0`). A zero exit that left work incomplete (`stopped`, e.g.
`no-ready-task` / shadow human gate) is still `abnormal: true` so the
artifacts alone distinguish quiet incompleteness from success.

**The engine is the single writer of `supervise.exit`.** It used to have two
incompatible formats on disk, because the retired bash continuity daemon
deleted the file before a relaunch and then `echo $?`'d a bare exit code
over it — which destroyed the `reason`/`abnormal` evidence and left a `0`
that could not be told apart from a zero-exit with work unmerged. Relaunch
probe evidence now goes to `supervise.relaunch-exit` instead.
`SuperviseExitRepository.read` still parses the bare-integer form,
reporting it as `abnormal: true`, so pre-Wave-0 run directories remain readable.

**Detection boundary:** exit traps own every termination Node can handle.
`SIGKILL`, OOM-kill, and power-loss cannot run a handler by definition —
dead-supervisor relaunch and heartbeat staleness kill are
`ContinuityService` / `StaleAgentService` inside the per-workspace KeepAlive
daemon (`supervise.pid` liveness + `launch.json` replay). The bash
`sdlc-continuity-daemon.sh` StartInterval agent is retired (P2 T-05);
`daemon install` unloads `com.rosetta.sdlc-daemon` before loading KeepAlive.
Startup-window death (child dies before the first wave) is still caught by
the detach parent's post-spawn grace probe (PR #83/#84).

### Durable launch queue (SPEC-BUG-retro-and-queued-plans-P1 T-02)

Planning is parallel but hand-off was manual: approving spec B while spec
A's supervised run is still active used to strand B — nothing launched it
when A finished. `queue-run --spec <path> --repo <path> …` closes that gap
with a durable FIFO record, `<runsDir>/queue/<n>.json`, capturing the same
argv surface as the continuity daemon's `launch.json` (`argv`, `execArgv`,
`execPath`, `cwd`) so a later launch needs nothing else on hand. A second
`queue-run` for the same spec path is a no-op (dedup by resolved path);
`status --queue` lists every queued record, oldest first.

The completing supervise loop is the interim consumer: once an **enforce**
run (never `--shadow`) merges every task, it peeks the queue head and —
the same `buildSuperviseChildArgv` + process-detach mechanics `--detach`
already uses — launches it detached, but only once that record's own spec
reads `status: Approved` from `origin/<default>` (a working-tree fallback
covers a spec outside the queued repo checkout). An unapproved head stays
queued with a visible `[queue] … not yet Approved` `monitor.log` line, so
it is retried at the next enforce completion rather than dropped. A launch
that fails to start (spawn error, or the child dies before it survives the
same startup grace window `--detach` uses) is never a silent drop either:
the record stays queued for retry and a durable `sdlc_queue_launch` wake
surfaces the failure. This is the interim consumer only — PRD-0020's event
daemon later owns the same queue via its watch registry against this
unchanged record format.

## Repo-owned `.sdlc/` contracts

The engine never owns deployment or test mechanics — the target repo
declares them:

```jsonc
// .sdlc/environments.json — only the "sandbox" entry is ever read (S-04:
// no code path can reach any other environment). Commands receive the
// deployed SHA as SDLC_SANDBOX_SHA and, when the engine knows it, the base
// of the change as SDLC_SANDBOX_BASE_SHA; health output must echo the
// deployed SHA.
{
  "sandbox": {
    "deployCommand": "git push origin HEAD:build-env/dev && gh run watch --exit-status",
    "healthCommand": "curl -fsS https://app.dev.example.com/health",
    "timeoutMinutes": 45 // default
  }
}
```

Both commands run with these variables exported:

| Variable                | Always set | Meaning                                             |
| ----------------------- | ---------- | --------------------------------------------------- |
| `SDLC_SANDBOX_SHA`      | yes        | The SHA being deployed. Health output must echo it. |
| `SDLC_SANDBOX_BASE_SHA` | no         | The gate base the task is measured against.         |

`SDLC_SANDBOX_BASE_SHA` (SPEC-PRD-0011-P4) is the task's integration tip —
the same `baseRef` the envelope and reviewer gates diff against — so a repo
can run `git diff $SDLC_SANDBOX_BASE_SHA..$SDLC_SANDBOX_SHA` and decide
whether the change is worth shipping. At the phase boundary it is the run's
frozen base, so the diff covers everything the phase merged. It is omitted
where no base is meaningful (notably the `check-veto` redeploy, where the
relevant diff is the revert itself); scripts should then fall back to their
own `git merge-base`.

**Path policy is repo-owned.** The engine stays path-agnostic: it exports the
base and nothing more. Whether a given diff means skip, a partial deploy, or
a full one is decided entirely by the repo's `deployCommand` — see
`comita_admissions` (`.sdlc/sandbox-deploy-ignore.yml` plus
`scripts/sdlc/sandbox-path-decision.py`) for the first implementation. A
skipping repo must still echo `SDLC_SANDBOX_SHA` from its health command;
that contract is unconditional.

```jsonc
// .sdlc/verification.json — scripted check for test-tier criteria.
{ "testCommand": "bun test" }

// .sdlc/surfaces.json — forbidden-surface label → path globs. Also grounds
// synthesis (#36): decompose aborts on any forbiddenSurfaces label missing
// from this map (SURFACE_UNRESOLVABLE) instead of dropping it.
{ "migrations": ["**/migrations/**"] }
```

```markdown
<!-- .sdlc/review-checklist.md — optional; a flat checkbox list the reviewer
     evaluates item by item (T-01). Trailing "(mandatory)" is a hard bar: a
     failed mandatory item overrides a concurring verdict. Absent file →
     unchanged pre-checklist prompt/verdict shape. The engine ships no
     content — the workspace's HSR/inline-docs bar lands here via
     team-setup; other consumers declare their own. -->

- [ ] Every new HSR class has TSDoc (mandatory)
- [ ] Prefer readability over cleverness
```

A missing contract never fails the run: the corresponding gate records
itself `blocked` (sandbox) or degrades the criteria to `human-required`
(verification), keeping the shadow-mode phase verdict honest. The one
evaluation-time exception is the surface map: an envelope that declares
`forbiddenSurfaces` cannot be judged without it, so a missing
`surfaces.json` at the judged tree is a named breach reason (see below). A
second, fail-closed exception is synthesis time: `decompose` refuses to
write a spec whose `forbiddenSurfaces` cannot all resolve against
`surfaces.json` (a missing map resolves no labels), because a label no gate
can enforce is a silent compliance hole, not a degradable check.

### Path-aware deploy: `SDLC_SANDBOX_BASE_SHA` (SPEC-PRD-0011-P4)

Both sandbox commands receive two variables:

| Variable                | Meaning                                                                              |
| ----------------------- | ------------------------------------------------------------------------------------ |
| `SDLC_SANDBOX_SHA`      | The commit being delivered. Health output **must** contain it verbatim.              |
| `SDLC_SANDBOX_BASE_SHA` | The base that commit is a change _against_, when the engine knows it. May be absent. |

The base is the task's integration tip for a task deploy (the same ref the
envelope and reviewer gates diff against), the run's starting tip for the
phase-boundary deploy, and the default-branch tip for a veto revert. It is
exported only when non-empty: an empty value looks "set" to
`[ -n "$SDLC_SANDBOX_BASE_SHA" ]`, so a script would take the range path with
no range, conclude nothing changed, and silently skip a real deploy. When it
is absent a script should fall back to its own `git merge-base`.

**Path policy is repo-owned, deliberately.** The engine publishes the range
and nothing more. What counts as deployable differs per repo — a filter baked
into the engine would be wrong for the next consumer, and a repo's own
`.github/path-filters.yml` applies to `push`, not to a `workflow_dispatch` the
engine triggers. A consumer that wants a fast-pass for docs-only or test-only
changes decides that in its deploy script, exits 0 without dispatching, and
has its health script print `SDLC_SANDBOX_SHA` with a skip marker so the SHA
echo contract still holds.

### Deploy ledger: content-keyed dedup and race avoidance (SPEC-PRD-0022-P1)

Every deploy is recorded in `<runsDir>/<runId>/deploys.jsonl`, an append-only
ledger keyed by the **tree-content SHA** (`git rev-parse <commit>^{tree}`)
rather than the commit. A merge commit's SHA always differs from the PR head
it merged even when the tree is byte-identical, so commit comparison reported
"never deployed" for content that was already live and paid for the deploy
twice.

Each record carries the content SHA, the commit, the trigger (`task`, `merge`,
`phase-boundary`, `push`), the workflow run URL when the deploy script printed
one, and a status of `in-flight`, `healthy`, `failed`, or `reused`. The
in-flight marker is written _before_ dispatch, because the window a concurrent
trigger needs to see is exactly the one where a deploy is running.

Three skips come out of it:

- **Content live under another commit → reuse.** Neither deploy nor health
  runs, and a `reused` record names what it reused. The health probe is
  skipped on purpose: the live app answers with the commit it was deployed
  from, so probing it for the new SHA would fail on identical content. The
  ledger record is the evidence.
- **A deploy of this content is in flight → dispatch skipped, health probed.**
  This is the phase-boundary-versus-push race. A second dispatch cannot make
  the target converge sooner and can thrash it; if health has not caught up
  the verdict is red and a later wave retries.
- **This exact commit already healthy → deploy skipped, health verified.** The
  pre-existing SHA idempotency, now also satisfied from the ledger rather than
  only from run state — run state keeps just the latest deploy, so a later
  deploy overwriting the record used to force a redundant redeploy.

**Push deploys are invisible to the ledger until observed.** A
`push`-triggered Actions run is started by GitHub, not by the engine, so it
never writes an in-flight marker on its own. Repos that ship via a named
workflow (e.g. `deploy-organization.yml` on `build-env/*`) should declare it
on the sandbox contract:

```json
{
  "sandbox": {
    "deployCommand": "bash scripts/sdlc/sandbox-deploy.sh",
    "healthCommand": "bash scripts/sdlc/sandbox-health.sh",
    "deployWorkflow": "deploy-organization.yml",
    "timeoutMinutes": 30
  }
}
```

When `deployWorkflow` is set, the sandbox step queries Actions for runs of
that workflow at the commit SHA before dispatching. An in-flight or successful
external run is recorded under trigger `push` and the engine stands down
(health only) — the same skip path the ledger already used for engine-owned
in-flight markers. Observation fails open: a `gh` error is treated as
"absent" so a flaky Actions query cannot strand delivery.

Ledger records survive restart and are readable by run ID after the run ends.
When git cannot resolve a tree SHA the ledger is skipped for that dispatch and
the deploy proceeds as it did before: a missing content key costs at most one
redundant deploy, which is a better trade than failing delivery outright.

### Tree-resolution rule for evaluation-time `.sdlc/` reads

Any gate that reads a `.sdlc/` contract while judging a change must read
it from the **git tree under judgment** — the task's PR tip (or the merged
integration tip for phase-level checks) — never from the operator's local
checkout (SPEC-BUG-envelope-spec-integrity-P1 T-03). A locally edited
(uncommitted) contract therefore cannot sway a verdict, and a contract
missing from the judged tree is a **named gate error**, not a silent
local-file fallback.

Audit of evaluation-time `.sdlc/` call sites and how each complies:

- **Envelope gate → `surfaces.json`** — resolved as a git blob at the
  gate's `headRef` via `SurfaceMapRepository.loadAtRef` (`git show
<ref>:.sdlc/surfaces.json`). Missing at that ref with
  `forbiddenSurfaces` declared → breach reason naming the contract path
  and the judged ref. `SurfaceMapRepository.load` (working-tree read)
  remains for synthesis-time use only; gates must not call it.
- **Reviewer gate → `review-checklist.md`** — resolved as a git blob at
  the gate's `headRef` via `ReviewChecklistRepository.loadAtRef` (T-01,
  same pattern as the surface map). Missing at that ref is not an error —
  the contract is optional, so a missing file degrades to the
  pre-checklist prompt/verdict shape rather than blocking the run.
- **Sandbox gate → `environments.json`** — loaded from the task
  **worktree**, which is the engine-owned checkout of the judged branch
  tip (commands must execute from a filesystem checkout). Compliant: the
  worktree _is_ the judged tree.
- **Verification (test tier) → `verification.json`** — same worktree
  rule as the sandbox contract. Compliant for the same reason.

## Resumable step graph (T-09)

Every pipeline step — implementation, each gate, the digest post, the
Chronicle commit — is cached in run state under a key derived from a
SHA-256 **inputs digest** rooted at `{task content, integration tip}` and
chained through the worktree head SHA. Wave-1 tasks use the frozen run
`baseSha`; after `record-merge --task`, dependents branch from (and
envelope/reviewer diff against) the post-merge tip — see
[`docs/merged-tip-baseRef.md`](./docs/merged-tip-baseRef.md). Kill the run
at any boundary and rerun the same command: cache hits are replayed
(agents are not re-invoked, the sandbox is not redeployed, digests are not
re-posted), and only steps whose inputs changed or never completed execute.
Editing a task's spec content changes its digest and invalidates exactly
that task's chain. `status` shows what is cached versus what would
re-execute.

This repo dogfoods the pipeline against itself:
[`SPEC-LIVE-VALIDATION-P1`](../specs/PRD-0011/live-validation-spec.md) is a
one-task harness spec, and the root `.sdlc/` contracts declare a local
process sandbox (`scripts/sandbox-deploy.sh` stages the built CLI keyed by
`SDLC_SANDBOX_SHA`; `scripts/sandbox-health.sh` echoes it back).

## Chronicle integration (T-07 / T-08)

With `--chronicle-repo` set, the phase boundary:

- commits versioned JSON artifacts (`sdlc.spec.v1`, `sdlc.task-result.v1`,
  `sdlc.verdict.v1`, `sdlc.exceptions.v1`, `sdlc.digest.v1`,
  `sdlc.merge.v1`) under `chronicles/sdlc/<run-id>/`, and
- posts one informational digest item to the PRD-0007 personal queue
  (`chronicles/queue.md`, Inbox) — no veto or revert semantics this phase.

Ledger commits follow ADR-0007: `chronicle(sdlc): ...` /
`chronicle(queue): ...` with `Chronicle-Window:` and `Generated-By:`
trailers. Verdict artifacts carry gate identity, inputs digest, outcome,
and resolvable evidence refs, and read back through
`GatePolicyQueryService` so future gate policy can learn from track record.

For a `SPEC-BUG-*` run, the same phase boundary also dispatches one retro
inference call over the spec's Context section and the run's full
verdict/exception history — "what would have caught this earlier, and
which stage should own that check" (SPEC-BUG-retro-and-queued-plans-P1
T-01). Recommendations commit as one `sdlc.retro.v1` artifact and link
from a `[retro]`-tagged queue Inbox item. Idempotent across resume;
non-`BUG-*` runs unaffected; a model failure degrades
loud-but-nonblocking with a `[retro] WARNING` in `monitor.log`.

**Verdict outcomes (BUG-reviewer-house-bar-P1 T-02):** `record-merge --task`
and `check-veto`'s revert path each annotate the affected task's gate
verdicts with a compact `sdlc.outcome.v1` artifact — `outcome: stood` when
the merge holds, `outcome: vetoed` when a queue veto reverts it — one
record per `(runId, taskId, gate)`, keyed so a resumed run overwrites
rather than duplicates. This makes per-gate precision (how often a concur
preceded a veto/rework, how often a breach was overridden) computable from
the ledger; no read-side reporting ships in this task.

## Environment

Inference runs over one of three transports, selected automatically:
`ANTHROPIC_API_KEY` present → Anthropic API (PRD-0011 §5 default); else
`OPENAI_API_KEY` present → OpenAI Responses API; otherwise the operator's
logged-in Cursor Agent CLI session (`cursor-agent -p`, the same
operator-auth pattern as `gh`).

| Variable                 | Required | Purpose                                                                  |
| ------------------------ | -------- | ------------------------------------------------------------------------ |
| `ANTHROPIC_API_KEY`      | no\*     | Anthropic API model calls (ADR-0003 / PRD-0011 §5)                       |
| `ANTHROPIC_MODEL`        | no       | Override the Anthropic default model (`claude-sonnet-4-5`)               |
| `OPENAI_API_KEY`         | no\*     | OpenAI Responses API model calls                                         |
| `OPENAI_MODEL`           | no       | Override the OpenAI default model (`gpt-5.6`)                            |
| `OPENAI_BASE_URL`        | no       | OpenAI-compatible gateway base URL (default: `api.openai.com`)           |
| `SDLC_INFERENCE_BACKEND` | no       | Force a backend: `anthropic`, `openai`, or `cursor-cli`                  |
| `CURSOR_AGENT_BIN`       | no       | Cursor Agent CLI binary (default: `cursor-agent`)                        |
| `CURSOR_MODEL`           | no       | Model passed to the Cursor Agent CLI                                     |
| `SDLC_AGENT_DATA_DIR`    | no       | Override engine agent transcript root (default: `~/.rosetta/agent-data`) |

\* With neither key set, a logged-in `cursor-agent` session is required.

## Architecture

Handler / Service / Repository with InversifyJS (workspace rule):

- `handlers/workflow.handler.ts` — Phase 1 pipeline, prints the gate.
- `handlers/run.handler.ts` — pooled task loop: parallel executor wave +
  per-task gates + P3 T-04 enforcement (auto-merge on green, escalate on
  red, `--shadow` to record only) + digest/Chronicle steps, all through
  the T-09 step cache.
- `services/decompose.service.ts` — PRD → `ProductStory[]` (right-sizing prompt).
- `services/spec-synthesis.service.ts` — stories → tasks + envelope → validated
  ADR-0008 Markdown. Grounds `allowedPaths` in the target repo tree
  (`utils/envelope-grounding.ts`, #35): ungrounded globs fail with
  `ENVELOPE_UNGROUNDED`; task-note paths outside the envelope surface as
  diff-forecast warnings. Fails closed on `forbiddenSurfaces` labels that do
  not resolve against the target repo's `.sdlc/surfaces.json` (#36).
- `services/executor.service.ts` — approved-spec intake and the P3 T-01
  task pool: merged-dependency eligibility, bounded parallel agent
  fan-out, one worktree per task. Persists the #37 launch record
  (`state.json`) before intake so forensics survive a mid-start crash.
- `services/envelope-gate.service.ts` — diff vs blast-radius envelope,
  shadow-mode verdict (T-02); resolves `surfaces.json` at the judged ref,
  never local disk (envelope-spec-integrity T-03). `maxDiffLines` exempts
  test files (`*.test.*` / `*.spec.*` / `__tests__/**` / `__mocks__/**`,
  `isTestPath`) from the size budget — they still count for `allowedPaths`
  / `forbiddenSurfaces` (BUG-retro-and-queued-plans-P1 retro).
- `services/pr-lifecycle.service.ts` — P3 T-02: push the task branch,
  find-or-create its PR with deterministic title/body (`utils/pr-content`).
- `services/sandbox-deploy.service.ts` — task-branch build → sandbox via the
  repo-owned contract; idempotent per SHA / content, optional
  `deployWorkflow` observation so phase-boundary stands down for a
  push-triggered Actions deploy of the same commit; health must report the
  deployed SHA; structurally unable to reach any other environment (T-03).
- `repositories/deploy-observation.repository.ts` — query Actions for
  in-flight / succeeded runs of the contract's `deployWorkflow` at a SHA.
- `services/verification.service.ts` — tiered acceptance-criteria runner:
  test-tier via the repo's scripted check, agent-tier via an independent
  verifier agent driving the sandbox, manual-tier forces human-required;
  every criterion verdict references its evidence artifact (T-04).
- `services/reviewer-publish.service.ts` — surfaces reviewer on the task PR
  (commit status context `sdlc/reviewer` + overview comment); best-effort
- `services/reviewer-gate.service.ts` — independent reviewer agent over the
  diff + task + envelope only; concur/disagree with cited reasons and the
  full transcript attached (T-05). When the target repo declares
  `.sdlc/review-checklist.md`, the prompt includes it and the verdict
  carries per-item `checklistFindings`; a failed `mandatory` item overrides
  a model concur to disagree (SPEC-BUG-reviewer-house-bar-P1 T-01).
- `services/aggregator.service.ts` — combines ci / verification / reviewer /
  envelope / sandbox into one phase verdict and derives exception-ledger
  entries (reviewer disagreement, third CI fix attempt, envelope breach,
  failed sandbox deploy, budget exhaustion) (P2 T-06). A repo with no
  sandbox contract is distinguished from a sandbox that deployed unhealthily
  — only the latter blocks.
- `services/gate-remediation.service.ts` — Wave 0: re-dispatches the
  implementation agent against a red reviewer or envelope gate in the task's
  existing worktree, commits and pushes the fix so the gates re-judge the
  new head. Bounded by `gateFixAttempts` per task and the run's token
  budget; envelope remediation must trim the diff, never widen the envelope
  (`utils/gate-fix-prompt.ts`).
- `utils/operator-unstick-prompt.ts` — SPEC-PRD-0025-P1 T-02: headless
  operator-unstick mandate (rebase/integration tip, out-of-band merge +
  `record-merge`, resume) distinct from gate-fix; abstain on
  Draft→Approved, live smoke/veto, PHI, envelope widening, and mid-run
  `specs/**` closeout rather than silent policy rewrite.
- `services/operator-unstick.service.ts` — SPEC-PRD-0025-P1 T-03: headless
  dispatch after remediable remediation exhausts; cleared/risky-proceed
  suppress blocking escalate; abstain/exhaust/authority-bound keep the
  ACTION REQUIRED + issue-state resume path.
- `services/escalation.service.ts` — P3 T-06 / fail-loud T-04: turns
  exception entries into interrupting `action-required` queue items,
  assigned needs-human GitHub issues (`--operator` / `SDLC_OPERATOR`), and
  durable wake-inbox events (idempotent by title **and** `occurrenceKey`, so
  the same finding on a new head SHA re-notifies). Issue body / wake / queue
  tags carry rich operator refs when known: **Blocker PR**, branch, head SHA,
  spec path, verification human-required criteria, failed CI check URLs, and
  sandbox sha/status/evidence (`utils/escalation-refs.ts`). When the task
  checkout's `origin` slug is known, Branch / Head / Spec / sandbox SHA render
  as GitHub `tree` / `commit` / `blob` markdown links; repo-relative paths
  inside human-required criteria (e.g. `sdlc-workflow/README.md`) are
  linkified the same way. `runs://…` evidence stays monospace — that scheme is
  local engine evidence, not a browser URL. Swallowed GitHub
  failures append a loud `monitor.log` warning without blocking the run.
  Issue creates always run as the workspace GitHub App (Addi) via
  `envForAddiWrite` — ambient human `gh` auth is refused with `GH_NOT_ADDI`
  rather than filing under the operator's login.
- `repositories/issue.repository.ts` — `gh issue` create / find-by-title
  (creates require Addi).
- `utils/gh-auth.ts` / `utils/gh-cli.ts` — shared `gh` runner; calls mint or
  reuse an Addi installation token (`SDLC_GH_ACTIVATE` /
  `ROSETTA_GH_ACTIVATE` / `~/.config/*/github-app-activate.sh`). The script is
  selected by the **owner being addressed** — a workspace App is installed on
  its own org only, so the wrong one authenticates and then fails the write
  with `Resource not accessible by integration`.
  **Reads take the same identity as writes.** An installation token is valid
  for 60 minutes and a detached run lasts far longer, so a run that inherits
  the operator's launch-time token starts failing every `gh` call about an
  hour in — the deploy watch, the CI poll and the escalation post at once,
  each reported as its own gate failure rather than as the single expired
  credential it is. Tokens are cached per activate script and re-minted at 45
  minutes; an auth failure re-mints and retries once, so a token that dies
  mid-call costs a retry rather than a wave. `ghEnv` exports the same
  credential for repo-owned subprocesses (sandbox deploy/health), which shell
  out to `gh` themselves. A read still falls back to ambient auth when no App
  resolves; a write refuses with `GH_NOT_ADDI`.
- `utils/gh-repo.ts` — `owner/repo` of the checkout's `origin`. Every `gh`
  call pins `--repo` to it: on a fork, an unqualified call resolves against
  the **upstream parent**, but task branches are pushed to `origin`, so PR
  creation and check-run lookups silently address the wrong repository.
  Resolves once per checkout and fails loud on a non-GitHub remote.
- `repositories/wake-inbox.repository.ts` — durable `~/.rosetta/wake` emits.
  `emitOnce` dedupes per (title, `occurrenceKey`); the occurrence is hashed
  into the marker so a long dedupe key cannot truncate it away.
- `services/ci-gate.service.ts` — the live CI gate (P3 T-03): waits a
  bounded appear window for the pushed branch's check runs to register,
  polls them to terminal, dispatches a fix agent on failure (failing logs in
  the prompt, ≤3 attempts persisted in `ciFixAttempts`), pushes fixes, and
  returns the post-cycle verdict with the cycle transcript as evidence;
  honest `blocked` when the branch is not pushed or when checks never appear
  within the window.
- `services/digest.service.ts` — phase-boundary digest to the PRD-0007
  personal queue; append-only. Veto is a separate `check-veto` command
  that reads the item back (T-07 / P3 T-05).
- `services/retro.service.ts` — `SPEC-BUG-*` phase-boundary retro: one
  inference call over the spec Context + verdict/exception history,
  committed as `sdlc.retro.v1` and linked from a `[retro]` queue item;
  append-only, same idempotency contract as the digest (T-01).
- `services/chronicle-commit.service.ts` — versioned run artifacts +
  merged-SHA / veto-revert recording (`sdlc.merge.v1`, `sdlc.revert.v1`),
  committed per ADR-0007 (T-08 / P3 T-05); also annotates the affected
  tasks' gate verdicts `stood` / `vetoed` via `sdlc.outcome.v1`
  (BUG-reviewer-house-bar-P1 T-02).
- `services/gate-policy-query.service.ts` — reads verdict artifacts back
  for gate-policy consumption (T-08).
- `repositories/` — PRD parsing (`prd`), model transports (`anthropic`,
  `openai`, `cursor-cli` behind the shared `IModelRepository` contract in
  `model`),
  schema-constrained inference with one retry (`inference`), spec file writes
  (`spec-file`), spec reads (`spec-doc`), git worktrees/diffs (`git`),
  workspace-mutating agent runs (`agent-runner`), resumable run state with
  the step graph (`run-state`), protected-surface map (`surface-map`),
  the optional review checklist (`review-checklist`), `.sdlc/` contracts
  (`contract`), contract command execution
  (`shell-command`), evidence artifacts (`evidence`), PRD-0007 queue
  appends (`queue`), Chronicle ledger artifacts + ADR-0007 commits
  (`chronicle-artifact`), GitHub check-run status (`ci-status`), and the
  `queue-run` durable launch queue — FIFO `<runsDir>/queue/<n>.json`
  records deduped by spec path (`run-queue`, T-02).
- `utils/` — pure functions: PRD parser, JSON-schema validator, spec renderer,
  ADR-0008 format validator, spec parser (round-trip of the renderer, now
  including the Context section), spec format lint (`spec-lint`, the
  hook/CI-safe pre-intake guard), glob matcher, criterion-tier parser,
  inputs digest (`digest`), a `monitor.log` line appender (`monitor`),
  queued-run argv construction (`queue-argv`, mirrors `supervise-argv` for
  the launch queue), the optional review-checklist markdown parser
  (`review-checklist`), and the implementation / reviewer / verifier /
  retro agent prompt builders.

## Testing

```bash
bun run test:coverage   # jest via @swc/jest; 90% global thresholds
```

Repo CI runs this suite on every PR (`.github/workflows/ci.yml`), alongside
`team-setup`.
