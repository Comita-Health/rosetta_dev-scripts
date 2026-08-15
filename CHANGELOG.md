# Changelog

## Unreleased

- **team-setup (Comita overlay):** fork templates keep brand / work-intake /
  Slack verify and add Comita drop arm defaults (Addi activate,
  admissions `--base-ref origin/build-env/dev`, `--require-approve`).
- **team-setup (PRD-0026):** drop is the default grain for inbox / direct
  work — `sdlc-drop` skill + `/sdlc-drop`. `run` / `decompose` stay the
  spec-task opt-in. Foundation `main` requires status checks only, so
  `drop --finish` merges unless **`--require-approve`** is set. That flag
  keeps human Approve / GHA merge-on-approve as the proceed signal.
  `BRANCH_PROTECTION_REQUIRES_HUMAN` only fires when protection actually
  requires a review.
- **sdlc-workflow (PRD-0026):** drop mode — `sdlc-workflow drop` arms one
  worktree and one PR per named set of GitHub issues. `maxDiffLines` is
  advisory (digest note). Token spend halts new agent dispatches at
  **3×** `budgetK`. Direct drops merge on machine gates and fail loud
  when branch protection still requires a human review
  (`--require-approve` opts back in).
- **sdlc-workflow:** `record-merge --task` now appends a run-state `phase: stood`
  verdict when a human approved the merge after a red/missing phase, and
  closeout treats `stood` + `mergedSha` as phase coverage so `status: Done`
  can be derived without hand-editing the SPEC (#169).

- **sdlc-workflow (SPEC-PRD-0025-P1 T-03):** Dispatch headless operator-unstick
  after remediable gate remediation exhausts, before ACTION REQUIRED.
  `OperatorUnstickService` runs on the local supervise/daemon path via
  `AgentRunnerRepository` (no chat/session). Cleared / risky-proceed
  suppress `EscalationService.post` for that wave; abstain / exhaust /
  authority-bound keep the existing escalate + issue-state watch path.
  Escalate tier is `unstick-in-flight` while the agent turn runs.
  Wired from `run.handler` `remediationRound` only when remediable
  `gateFixAttempts` are exhausted (token-budget skips do not dispatch).
  Policy-rewrite detection covers committed mid-run `specs/**` /
  envelope-limit edits (not only a dirty tree; fail-closed when git
  status/diff throws) and always classifies those turns as abstained —
  agent `risky-proceed` / `risky-advisory` text cannot self-authorize.
  `cleared` requires durable blocker-clear evidence (disk-reloaded
  `mergedSha` / record-merge, or `OUTCOME: cleared` marker + HEAD move) —
  never agent text / resume wording alone, a bare marker, or HEAD move
  alone; the unstick prompt instructs that marker syntax.

- **sdlc-workflow (SPEC-PRD-0025-P1 T-02):** Author `buildOperatorUnstickPrompt`
  with an explicit operator mandate (rebase/integration tip, out-of-band
  merge + `record-merge`, resume via existing engine CLIs) distinct from
  gate-remediation trim-the-diff. Authority-bound and policy acts
  (Draft→Approved, live smoke/veto, PHI, raising `maxDiffLines` /
  `allowedPaths`, mid-run `specs/**` closeout) instruct abstain — never
  silent Approved-spec rewrite. `buildGateFixPrompt` stays remediator-first.

- **sdlc-workflow (SPEC-PRD-0025-P1 T-01):** Persist operator-unstick attempt
  budget and outcome model on run state. `state.json` carries per-task
  `operatorUnstickAttempts`, latest `operatorUnstickOutcomes` (`cleared` |
  `abstained` | `risky-proceed` | `authority-bound` | `exhausted`), and
  `escalateTiers` (`unstick-in-flight` | `advisory-risky` |
  `halted-escalated`) via `RunStateRepository` — mirrored on
  `gateFixAttempts` so resume cannot refill the unstick budget.
  `OperatorUnstickService` typed stub registered for DI; dispatch in T-03.

- **sdlc-workflow (SPEC-PRD-0020-P2 T-05):** Retire the bash continuity
  StartInterval LaunchAgent. `team-setup` template scripts
  `sdlc-continuity-daemon.sh` and `install-continuity-daemon.sh` are
  fail-loud stubs that print migration to `sdlc-workflow daemon install`
  and exit non-zero (no tick / no plist write). `daemon install` /
  `daemon uninstall` unload and remove legacy `com.rosetta.sdlc-daemon`
  before loading or clearing the per-workspace KeepAlive agent so dual
  relaunch cannot happen during cutover. Session-mortal
  deploy-verify-watch and issue-resolve-watch scripts remain until
  Phase 3.

- **sdlc-workflow (SPEC-PRD-0020-P2 T-04):** Loud-failure semantics for the
  per-workspace daemon — when a watch exceeds the consecutive poll-failure
  cap, `PollSchedulerService` commits an operator-visible `poll-error` wake
  (idempotent per watch+reason via `commitPollErrorWake`) before marking
  `degradedAt`. Fatal bootstrap and unrecoverable tick errors exit non-zero
  (`daemonExitCode` / `exitDaemonFatal`) so launchd KeepAlive restarts the
  process; success paths remain the only exit 0. KeepAlive stays
  launchd-owned (no in-process restart loop).

- **sdlc-workflow (bug):** One ACTION REQUIRED GitHub issue per escalate
  wave (`runId` + `taskId`) — coalesce aggregator triggers such as
  `reviewer-disagreement` + `envelope-breach` into a single issue/wake
  instead of one issue per trigger (repro #92/#93). Resume reuses legacy
  per-trigger open titles when present.
- **sdlc-workflow (SPEC-PRD-0020-P2 T-03):** Continuity abandoned-run flagging
  and blocker-close wake use `RunStateRepository.idleSeconds`,
  `BlockerService` resumable reporting, and the shared
  `commitWatchSignal` / `issue-state` inbox path. A dead-supervisor run idle
  beyond `SDLC_ABANDONED_SECONDS` emits exactly one `abandoned` wake and is
  not relaunched. When needs-human blockers report resumable **and**
  supervise is dead, a `closed` wake is committed for
  `EngineResumeWakeAction`; relaunch/abandon are skipped only while that wake
  remains pending — not permanently while historical exceptions stay
  `resumable`. Continuity does not become a second resume engine. Operator
  docs no longer treat `sdlc-continuity-daemon.sh` as the safety net.

- **sdlc-workflow (SPEC-PRD-0020-P2 T-02):** `StaleAgentService` reads each
  run's `heartbeat.jsonl` on the continuity tick and, when an in-flight
  implementation heartbeat is quieter than `SDLC_AGENT_STALL_SECONDS`
  (default 2400), performs one kill attempt scoped to that `runId` and
  commits one idempotent `agent-stalled` wake via `commitWatchSignal`.
  Skips finished runs (`allTasksMerged`) and runs without usable
  `state.json` before kill/wake — matching bash continuity and
  ContinuityService finish gates. Episode-keyed wake ids re-arm after the
  heartbeat recovers so a later stall notifies again — no machine-global
  kill of unrelated agents.

- **sdlc-workflow (SPEC-PRD-0020-P2 T-01):** `ContinuityService` scans the
  workspace `runsDir` each daemon tick and relaunches unfinished runs whose
  `supervise.pid` is dead, replaying `launch.json` argv/execArgv under
  `RunLockRepository` so dual relaunch is impossible. Skips finished runs
  (`allTasksMerged`), unresolved needs-human blockers, and abandoned idle
  runs. Relaunch evidence goes to the run monitor/supervise log and a
  `supervisor-restarted` wake via `commitWatchSignal` — no chat session,
  deploy, or Draft→Approved path. Wired from daemon lifecycle DI.

- **sdlc-workflow:** sandbox deploy observes push-triggered GitHub Actions
  runs when the sandbox contract names `deployWorkflow` (e.g.
  `deploy-organization.yml`). Phase-boundary no longer double-dispatches
  against an in-flight or successful push deploy of the same commit SHA —
  the external run is recorded under trigger `push` and the engine stands
  down to health-only (SPEC-PRD-0022-P1 T-03 gap: ledger previously saw only
  engine-owned dispatches). Observation fails open on `gh` errors.

- **sdlc-workflow (PRD-0020 remote-resume):** `--supervise` / `--detach` persist
  `launch.json`; watches carry `resumeContext` into wake data; `issue-state`
  adapter + CLI kind; `pr-review` emits `merged` (with merge OID) before
  expire; `engine-resume` wake action record-merges out-of-band landings and
  relaunches supervise when the pid is dead; escalations register issue + PR
  watches so remote blocker-close / PR-merge can unstick a run without chat.

- **sdlc-workflow (#79):** red-phase / merge-blocked path reconciles
  already-merged task PRs (GHA Addi merge-on-approve or human `gh pr merge`)
  via `mergeCommitOid` before escalating, records `mergedSha` with Chronicle
  `approvedBy: out-of-band`, and continues the wave so dependents /
  `queue-run` are not stuck waiting for a manual `record-merge`.
  `recordTaskMerged` zeros `mergeBlockedRetries`. Detach clears stale
  `supervise.exit` before spawn and tails only post-spawn `supervise.log`
  bytes so re-detach does not false-fail on history.

- **team-setup:** workspace agent secrets onboarding — scaffold
  `~/.config/<workspace>/` (GitHub App activate + Slack + Cursor
  `sessionStart` hook), 1Password `op inject` materialize helpers, verify
  script (no secret echo), and walkthrough for shared Slack vs private /
  personal bot credentials
  (`docs/workspace-agent-secrets.md`, `scaffold-secrets` /
  `verify-secrets` CLI).

- **sdlc-workflow:** `extractJson` prefers an explicitly `json`-tagged fence
  anywhere in the response, then the earliest fenced object that parses, then
  a raw scan — so a leading checklist fence can no longer turn a passing
  verifier verdict into `no JSON object found in response`
  (SPEC-BUG-verifier-json-fence-P1 T-01).

- **Cursor Cloud / Comita environment:** `install-comita-cloud.sh` now
  rewraps space-collapsed single-line `GITHUB_APP_PRIVATE_KEY` pastes
  (Cursor secrets UI often replaces PEM newlines with spaces) in addition
  to quote / literal `\n` normalization, and validates the materialized
  PEM can deserialize when `cryptography` is available.

- **sdlc-workflow:** engine-spawned agents write transcripts under
  `~/.rosetta/agent-data` (override with `SDLC_AGENT_DATA_DIR`) instead of
  the operator's `~/.cursor` history root. `sanitizedAgentEnv()` sets
  `CURSOR_DATA_DIR` unconditionally on both dispatch paths; credentials
  still resolve from `CURSOR_CONFIG_DIR`. Resume with
  `CURSOR_DATA_DIR=~/.rosetta/agent-data cursor-agent ls`
  (SPEC-BUG-agent-history-isolation-P1 T-01).

- **team-setup:** document Comita Cloud GitHub **issue-comment** automation
  (`docs/comita-cloud-issue-automation.md`) — trigger, Addi identity rules,
  safe auto-remediation scope, and smoke test.

- **Cursor Cloud / Comita environment:** add `.cursor/environment.json` +
  `install-comita-cloud.sh` so the multi-repo **Comita** cloud environment
  materializes Addi (`~/.config/comita`) from environment-scoped secrets,
  installs bun/`gh` deps, and documents Cloud + Slack + Addi identity in
  `AGENTS.md`.

- **sdlc-workflow:** needs-human escalations now carry rich operator
  references alongside the **Blocker PR**: branch, head SHA, spec path,
  verification human-required criteria, failed CI check URLs (from the
  Checks API `html_url` / `details_url`), and sandbox sha/status/evidence.
  When the task checkout's origin slug is known, Branch / Head / Spec /
  sandbox SHA render as GitHub `tree` / `commit` / `blob` markdown links;
  repo-relative paths in human-required criteria are linkified the same way.
  `runs://…` evidence stays monospace (local engine URI). Wake payloads and
  queue tags include the same refs.

- **sdlc-workflow:** needs-human escalation issues (and their wake / queue
  tags) link the task **Blocker PR** when one is open, so the operator can
  jump straight to the actionable surface instead of reconstructing
  `sdlc/<runId>/<taskId>` from the title alone.

- **sdlc-workflow:** enforce runs no longer sandbox-deploy (or CI) a tip
  that envelope or reviewer already rejected. Remediable findings invoke
  `remediationRound` immediately; on success the pass abandons so
  re-selection re-gates the new head from the top. Skip/fail still
  escalates loudly without deploying the red head. Shadow mode keeps
  today's full gate order and never early-remediates
  (SPEC-BUG-early-reviewer-remediation-P1 T-01).

- **sdlc-workflow / team-setup:** absorb `pr-approve-watch` into a thin daemon
  client (SPEC-PRD-0020-P1 T-08). The skill script registers durable
  `pr-review` watches via `sdlc-workflow daemon watch` and prints
  `daemon status`, then exits — no local bash poll loop. The operator-facing
  wake contract is unchanged; only the transport moved. `daemon watch --kind`
  accepts `pr-review` and `pr-checks` — the kinds whose targets really are
  `owner/repo#N`. `.cursor` and `.claude` skill template copies stay
  content-identical (enforced by test).

- **sdlc-workflow:** add `sdlc-workflow daemon status` (human table and
  `--json`) over the watch registry and wake inbox. Output covers active
  watches (`kind`, `target`, `age`, `lastPollTime`), pending/consumed wakes,
  an explicit `unwatched` section (engine-known PRs/runs minus the active
  watch set), and a distinct degraded marker when a watch has exceeded the
  poll-failure cap (SPEC-PRD-0020-P1 T-07).

- **sdlc-workflow:** add the wake consumption engine and action-dispatch
  scaffold (SPEC-PRD-0020-P1 T-06). Pending wakes are claimed via the durable
  store's atomic rename, the winning consumer is stamped into `consumedBy`, and
  registered follow-up actions run afterward. Phase 1 ships only the best-effort
  `notify` action (desktop + chat-mirror channels); notification failure is
  recorded on the wake and never blocks or re-queues consumption. The action
  context carries no chat/conversation object so Phase 3 headless dispatch can
  plug in on the same interface.

- **sdlc-workflow:** add Phase 1 GitHub watch source adapters for `pr-review`
  (Approve, Request-changes, new review comments) and `pr-checks` (Checks API
  and status-context terminal states). `pr-checks` judges CI from the individual
  status contexts and every page of check runs, not the combined status rollup,
  whose `pending` state also means "no statuses" and would otherwise never let a
  Checks-API-only PR report terminal CI. Both emit normalized signals that the
  poll scheduler commits only through the shared wake-inbox writer under the
  workspace Addi activate-script identity with token refresh; Phase 3 kinds are
  not stubbed (SPEC-PRD-0020-P1 T-05).

- **sdlc-workflow:** add the daemon poll scheduler: every active watch is
  evaluated on its own declared cadence (the daemon's `defaultPollSeconds` is
  the idle ceiling, not the tick), each poll runs under an exclusive expiring
  per-watch lease, and adapter signals are committed through the durable wake
  ledger so an overlapping or retried poll cannot publish a second wake for one
  source event. A lease is acquired by exclusively creating the generation after
  the highest one on disk, so recovering a lease abandoned by a crash never
  unlinks a lease it does not own. Adapter failures are bounded: at three
  consecutive failures the watch is marked degraded and stops being retried
  inline while staying visible to status. A kind with no registered source
  adapter is skipped rather than failed, and the loop polls nothing at all until
  adapters are registered, so no watch is degraded by the daemon's own wiring
  (SPEC-PRD-0020-P1 T-04).
- **sdlc-workflow:** add the workspace-scoped durable watch registry lifecycle
  API with deterministic kind/target deduplication, active-watch age and
  last-poll projections, explicit expiry, and automatic expiry when a poll
  reports a terminal target state (SPEC-PRD-0020-P1 T-03).

- **sdlc-workflow:** add the per-workspace durable daemon store with one JSON
  file per watch and wake, idempotent wake IDs, fsynced publication, and
  atomic-rename wake claims. A write-once `wake/records/` ledger gates
  publication, so a re-detected signal cannot restore a pending file for an
  already-claimed wake and buy a second claim (SPEC-PRD-0020-P1 T-02).

- **sdlc-workflow:** a `daemon install` that cannot execute `launchctl` at all
  now names the cause. `spawnSync` reports that case as `status: null` with
  empty stdout/stderr, so the thrown `DAEMON_CONFIG_INVALID` carried a blank
  detail and told the operator only that "bootstrap failed"; the spawn error
  (e.g. `ENOENT` off macOS) is now surfaced, and a failure with genuinely no
  output no longer pads `details` with an empty string (SPEC-PRD-0020-P1 T-01).

- **sdlc-workflow:** `daemon install --no-load` works again — the flag is
  yargs' negation of `--load` (default true); declaring a literal `no-load`
  option made strict mode reject `--no-load` as `Unknown argument: load`
  (SPEC-PRD-0020-P1 T-01).

- **sdlc-workflow:** `daemon install` is transactional on macOS launchd —
  after a successful `launchctl bootstrap`, a failed `launchctl enable` boots
  the agent out and removes the plist so install never reports failure while
  leaving a loaded KeepAlive agent on disk (SPEC-PRD-0020-P1 T-01).

- **sdlc-workflow:** `daemon install` now creates `.sdlc/daemon/` and touches
  `daemon.log` before launchd bootstrap so StandardOutPath/StandardErrorPath
  exist at load time; `daemon uninstall` derives the label/plist path from the
  workspace root alone (no `.sdlc/daemon.json` required); and `launchctl
enable` failures after a successful bootstrap fail the install instead of
  reporting `loaded: true` while the agent stays disabled (SPEC-PRD-0020-P1
  T-01 remediation).

- **sdlc-workflow:** per-workspace event daemon skeleton (SPEC-PRD-0020-P1
  T-01). `sdlc-workflow daemon --workspace <root>` is a long-running process
  whose only required input is the workspace root; `DaemonConfig` (activate
  script, runs dir, poll cadence, headless runner) is loaded from
  `.sdlc/daemon.json` under that root, and pid/log/launchd label are derived
  per workspace so two roots never share a process. `daemon install` /
  `daemon uninstall` write (or remove) a KeepAlive=true launchd plist with a
  workspace-unique label. Bootstrap and lifecycle only — no watch/poll yet.

- **sdlc-workflow:** the engine now mints and refreshes its own GitHub token
  instead of living on the one the operator exported at launch. A GitHub App
  installation token is valid for 60 minutes; a detached supervised run lasts
  hours. So roughly an hour into every long run the inherited token went 401
  and took each consumer with it — `gh run watch` inside the repo-owned
  sandbox script (recorded as `sandbox gate: breach - deploy command failed`
  for a deploy workflow that had in fact succeeded), the CI gate's check-run
  query (`checkRuns` swallows any error and returns `null`, which the gate
  reports as `no CI results`), and the escalation `gh issue` call that was
  supposed to tell a human about it. One expired credential surfaced as three
  unrelated-looking gate failures and no issue, so a healthy PR sat unmergeable
  with nothing on GitHub explaining why — the operator had to notice by hand.
  Tokens are now cached per activate script and re-minted at 45 minutes, an
  auth failure re-mints and retries once, and reads use the same identity as
  writes so no code path is left on a separately-expiring credential.
  Repo-owned subprocesses receive the refreshed token too, since they shell out
  to `gh` themselves. Failure detail now includes `stderr`, which is where
  `gh` puts the reason — reporting `message` alone reduced every failure to
  `Command failed`.

- **sdlc-workflow:** every `gh` call now pins `--repo` to the checkout's
  `origin` remote. On a fork, an unqualified `gh pr create` / `gh issue create`
  resolves against the fork's **upstream parent**, while the engine pushes task
  branches to `origin` — so the PR call looked for a branch in a repository it
  was never pushed to and failed with `No commits between main and <branch>` /
  `Head ref must be a branch`. Wording that reads like a bad branch, but is a
  wrong-repository lookup that no gate remediation can fix. The same bug made
  `gh api repos/{owner}/{repo}/commits/<sha>/check-runs` query the parent, so
  the CI gate reported `no check runs after waiting 300s` for commits whose
  checks were green on the fork, and escalation issues landed on the wrong
  repository. `originSlug` resolves the remote once per checkout and fails
  loud rather than letting `gh` choose a repository the caller did not intend.

- **sdlc-workflow:** the Addi activate script is now chosen by the **owner
  being written to**, not by discovery order. A workspace's GitHub App is
  installed on that workspace's org only, so a run in a `Comita-Health`
  checkout that minted the `rosetta` App authenticated fine and then failed
  the write with `Resource not accessible by integration` — a permission error
  that reads like a missing grant but is the wrong App. Being Addi is likewise
  not sufficient to reuse the ambient session, since that session can hold a
  different org's Addi; when an owner-scoped script exists its token is minted
  in preference. Explicit `SDLC_GH_ACTIVATE` / `ROSETTA_GH_ACTIVATE` overrides
  still win.

- **SPEC-PRD-0020-P1 T-04:** the poll-scheduler agent acceptance criterion
  required an Approve event on a watched PR to surface as a wake against a
  running daemon. That could never hold inside T-04: the `pr-review` adapter is
  T-05's deliverable and T-05 depends on T-04, and `.sdlc/daemon.json` is a
  consumer-owned contract the engine repo deliberately does not carry. The
  criterion was unfalsifiable by construction, so verification breached on
  every attempt and the task escalated with no remediation available. It is now
  scoped to what T-04 delivers — cadence, the in-flight lease, and exactly-once
  wake commit — through a stub source adapter; the live GitHub path stays
  covered by T-05's existing criterion.

- **sdlc-workflow:** the reviewer prompt no longer ships domain-specific
  vocabulary as examples of invariants worth documenting. Examples are now
  generic ("authorization, data-sensitivity boundaries, idempotency, ordering,
  failure modes"); domain rules arrive through the consumer's own
  `.sdlc/review-checklist.md` (ADR-0009). A test pins the upstream prompt free
  of regulated-domain vocabulary and pins that a declared checklist still
  carries it.

- **sdlc-workflow:** phase closeout is now **derived, not authored**
  (SPEC-PRD-0023-P1). Five specs had landed with their work merged and their
  acceptance criteria still unticked — `PRD-0011/phase-1-spec.md` sat at 1 of
  15 — because closing out a spec was a manual writing job that nobody's
  definition of "done" required. When the last task of a phase merges, the
  engine now reads the run's recorded verdicts (`closeout-aggregate.service`)
  and opens a closeout PR whose entire diff is computed from them: a criterion
  with a passing verdict is ticked, and `status: Done` is written only when
  every criterion passes, every task merged, and every phase gate is green.
  Partial coverage leaves the existing status untouched and surfaces the gaps
  in a **Remainder** section rather than downgrading anything. The PR body
  cites `(task, gate, evidence link)` per verified criterion, and the Remainder
  section names the phase-level shortfalls — tasks with no merge commit, tasks
  with no passing phase gate — that withhold `Done` even when every criterion
  passes. Boxes a human
  ticked by hand are **never unticked** — that tick is a record of hand
  verification — but they do not count toward `Done` either, so they are
  reported explicitly.

- **sdlc-workflow:** a phase is no longer complete just because its tasks
  merged — `phaseComplete` also requires a closeout PR that is open or merged,
  queried live rather than cached (`utils/run-completion.ts`). A closed-unmerged
  PR, or a `gh` call that fails outright, both read as incomplete: claiming a
  phase is done on the strength of a network error is worse than making the
  operator look. The phase Chronicle artifact carries the closeout PR URL
  (`closeoutPr`), and the digest's cache key includes whether that link was
  available, so a closeout that only succeeds on a later attempt still gets
  published.

- **sdlc-workflow:** closeout PRs are identified by their branch
  (`sdlc/closeout/<spec-id>`), not their title, and are updated in place. An
  interrupted closeout re-run leaves exactly one PR reflecting the latest
  verdicts instead of a pile of near-duplicates. `closeout --run-id --spec
--repo` drives the same code by hand for specs that landed before the
  machinery existed.

- **sdlc-workflow:** `docs:` is a real verification tier at runtime, not only in
  the lint. `spec-lint` had accepted four tiers while `parseCriterionTier` knew
  three, so an Approved spec carrying a `docs:` criterion passed intake and then
  threw `SPEC_MALFORMED` in verification — which is why
  `BUG-envelope-spec-integrity` T-04 merged with no criterion verdicts at all,
  and why its closeout failed outright when it read the same spec back. `docs:`
  now records as human-required alongside `manual:`, and a test pins the two
  lists together.

- **sdlc-workflow:** `specs/**` keeps exactly one writer. The privileged route
  (`SpecFileRepository.writeCloseout`) refuses absolute paths, refuses to
  escape the checkout, refuses anything outside a `specs/` tree, and refuses to
  create a spec that is not already there — closeout amends an Approved
  document, it never authors one. Static pins in `spec-write-policy.test.ts`
  fail the suite if a second call site appears, if a spec write bypasses the
  repository, or if the issue #40 envelope-breach regression test is skipped or
  dropped from the suite CI gates merges on.

- **sdlc-workflow:** the CI gate no longer treats "GitHub has not registered
  a check run yet" as a verdict. A postmortem over 23 runs found **every**
  CI block in the corpus — 16 of 59 verdicts — read `no check runs` or
  `no CI results for <sha>`, with **zero actual CI failures**: the engine
  pushed, polled once before the check suite existed, marked `blocked`,
  escalated and exited. `ci-gate` now polls a bounded appear window
  (`checksAppearTimeoutMs`, default 5 min) before judging, distinguishing
  not-yet-reported (wait) from reported-and-failing (the existing ≤3-attempt
  fix loop) from appear-deadline-exceeded (escalate — a suite that never
  registers is a real misconfiguration).

- **sdlc-workflow:** a red **reviewer or envelope** gate now gets a bounded
  remediation round before it becomes a needs-human escalation. These were
  22 of 44 historical escalations and every one ended its run cold, even
  though median reviewer dispatch is 1.16 minutes — re-judging is cheap, so
  the terminal stop was pure waste. `gate-remediation.service` re-dispatches
  the implementation agent in the task's existing worktree with the failing
  verdicts' reasons as input, commits and pushes, and lets the gates judge
  the new head; the executor re-opens a task whose breached phase has a
  newer remediation so the fix is actually re-evaluated. Bounded by
  `state.gateFixAttempts` (default 2) and the run token budget, with
  exhaustion escalating loudly. Envelope remediation is instructed to reduce
  the diff and explicitly forbidden from raising `maxDiffLines` — a gate
  that negotiates its own threshold is not a gate.

- **sdlc-workflow:** the supervisor no longer exits on `merge-blocked`. That
  single behavior fired 28 times across 79 waves, each time ending the
  process and waiting for a hand relaunch, and accounts for the bulk of the
  1,560 idle minutes (62.7% of elapsed time) measured across the corpus. It
  now retries with backoff up to a bounded limit, invalidating the step-cache
  entries that could produce a different answer (`ci` and the phase
  aggregate) so the retry re-polls instead of replaying the cached block.
  Retries are counted in `state.mergeBlockedRetries`; exhaustion is still a
  loud terminal exit.

- **sdlc-workflow:** the **sandbox gate joined the aggregate**. Previously
  the aggregator received only `{ci, verification, reviewer, envelope}`, so a
  failed sandbox deploy did not block a merge and "it merged" never implied
  "it deployed". A declared sandbox that deployed unhealthily now blocks the
  phase and records a `sandbox-failed` exception; a repo with no
  `.sdlc/environments.json` still does not block, since the absence of a
  contract is not evidence of a broken deploy.

- **sdlc-workflow:** `emitOnce` woke a human exactly **once, ever** per
  escalation title — it deduped on the title alone and never cleared the
  marker, so recurrence was silently swallowed. Escalations now carry an
  `occurrenceKey` (branch head SHA, or the implementation digest for a task
  with no head) hashed into the dedupe marker: the same finding on unchanged
  content stays quiet, but the same finding after an agent pushed a fix
  re-notifies. Hashing (rather than appending) the occurrence keeps a long
  dedupe key from truncating the suffix away and silently re-deduping.

- **sdlc-workflow:** heartbeat coverage. Only `starting`, `implementation`
  and `reviewer` set a step label, leaving 52.6% of measured work
  unobservable and accruing sandbox / verification / ci / merge time under
  whatever label was left standing — which overstated reviewer time by
  ~3.5 minutes per segment across 51% of reviewer segments. Those four steps
  now set their own labels, and the verifier agent reports per-criterion
  progress through an optional sink on `VerificationInput`.

- **sdlc-workflow:** the engine is now the **single writer** of
  `supervise.exit`. `sdlc-continuity-daemon.sh` deleted the file before a
  relaunch and then `echo $?`'d a bare exit code over it, destroying the
  `reason`/`abnormal` evidence and leaving two incompatible formats on disk
  — a bare `0` was indistinguishable from a zero-exit that left work
  unmerged. The daemon's relaunch probe writes `supervise.relaunch-exit`
  instead; `SuperviseExitRepository.read` still parses the legacy bare form
  as `abnormal: true` so existing run directories stay readable.

- **sdlc-workflow:** `state.json` writes are now **atomic and single-writer**
  (SPEC-PRD-0021-P1 T-01/T-02). Every save goes through a temp file in the
  same directory, `fsync`, then `rename`, so a crash mid-write leaves the
  previous state fully parseable and a concurrent reader never observes a
  truncated file. A `run.lock` in the run directory, taken by exclusive file
  create, makes the continuity-relaunch-versus-manual-resume race structurally
  impossible instead of merely unlikely: `run` / `supervise` hold it for the
  session, short-lived mutators take a momentary lock around their write, and
  a second engine fails immediately with `RUN_LOCK_HELD` naming the live pid,
  host, owner and start time. A lock whose owner is dead on this host is
  reclaimable so a SIGKILLed run stays resumable; a pid on another host never
  is, since it cannot be probed from here.

- **sdlc-workflow:** `retry-executor.service` is the engine's single
  retry-policy surface (T-03): attempt cap, doubling backoff capped at 30s,
  and the `RecoveryHistory` record schema defined exactly once for the later
  gate-retry and breaker consumers. It re-invokes the caller's step and
  nothing else — it holds no reference to a verdict type and has no branch
  that can construct or soften one, because a retry layer able to do that
  would make every gate advisory. Exhaustion escalates once and returns; it
  never loops past the cap.

- **sdlc-workflow:** the three non-gate steps — PR open, sandbox deploy and
  Chronicle commit — are retried through that executor with their attempt
  trail recorded on the step (`steps[<key>].recovery`), so a flaky step is
  visible after the fact rather than only in a log the operator no longer has
  (T-04). Only a _thrown_ sandbox error retries; an unhealthy deploy is a
  verdict. Recovered steps land in the step cache like any other, so a resume
  reuses them with zero hand-edits and no duplicate PR, deploy or ledger
  commit. Gates themselves are deliberately not retried in this phase.

- **sdlc-workflow:** agent dispatches run with a **sanitized environment**
  (T-05). Nested-agent markers — `CURSOR_AGENT`, `CURSOR_INVOKED_AS`,
  `CURSOR_CONVERSATION_ID`, the askpass socket/secret pair, `AGENT_TRANSCRIPTS`
  and the Claude Code equivalents — are stripped before spawning, for both the
  workspace-mutating runner and the `cursor-agent -p` completion transport
  that carries the reviewer, verifier and decompose prompts. A child that
  inherits them can decide it is re-entrant and exit without doing the work, a
  silent no-op indistinguishable from "nothing to change", after which every
  gate judges an unmodified branch. Deliberately a denylist rather than a
  `CURSOR_*` wildcard, since the engine dispatches _with_ `CURSOR_AGENT_BIN`
  and `CURSOR_MODEL`.

- **sdlc-workflow:** a detached launch is now verified rather than assumed.
  The parent sampled child liveness exactly once at 1.5s, and on a loaded
  machine that sample landed while the child was still booting `tsx` — so it
  printed "detached", exited 0, and the operator walked away from a run that
  died a second later. It now watches for up to 8s and stops early on evidence
  either way: the child's own `supervise.exit` record, or a dead pid.

- **sdlc-workflow:** the sandbox contract is now **path-aware**
  (SPEC-PRD-0011-P4 T-01/T-04). Deploy and health commands both receive
  `SDLC_SANDBOX_BASE_SHA` alongside `SDLC_SANDBOX_SHA` — the task's integration
  tip for a task deploy, the run's starting tip at the phase boundary, the
  default-branch tip for a veto revert — so a repo-owned script can decide from
  `base..head` whether anything deployable changed. Observed cost of not having
  it: a task that touched only an inventory doc and shared unit tests still
  dispatched both application stacks and waited for the live app to serve that
  SHA. Path policy stays repo-owned; the engine publishes the range and no
  filter. The variable is exported only when non-empty, because an empty value
  looks "set" to a shell test and would make a script conclude nothing changed
  and skip a real deploy.

- **sdlc-workflow:** deploys are recorded in an append-only ledger keyed by
  **tree content**, and three kinds of redundant deploy are now skipped
  (SPEC-PRD-0022-P1 T-01/T-02/T-03). `<runsDir>/<runId>/deploys.jsonl` captures
  each dispatch's content SHA, commit, trigger, workflow run URL and terminal
  outcome, with the in-flight marker written before dispatch. Content already
  live under a different commit is **reused** rather than redeployed — a merge
  commit's SHA always differs from the PR head it merged even when the tree is
  byte-identical, which is why commit comparison kept paying twice, and why the
  reuse path skips the health probe too (the live app answers with the commit it
  was deployed from). A content SHA another trigger is already deploying is
  never dispatched a second time: the phase boundary stands down for an
  in-flight push deploy and only probes health, so a lost race costs a retry on
  a later wave instead of two jobs fighting over one target. Reuse and skip
  decisions are recorded as their own events, because "no deploy happened" must
  be distinguishable from a dedup bug that lost the dispatch. An unresolvable
  tree SHA disables the ledger for that dispatch rather than failing the run.

- **sdlc-workflow:** `queue-run --spec <path> --repo <path> …` writes a
  durable FIFO launch record (`<runsDir>/queue/<n>.json`, deduped by spec
  path) capturing the same argv surface as the continuity daemon's
  `launch.json` (SPEC-BUG-retro-and-queued-plans-P1 T-02). When a supervised
  enforce run completes with every task merged, the supervise loop pops the
  queue head and — the same relaunch mechanics `--detach` already uses —
  launches it detached once its spec reads `Approved` on `origin/<default>`;
  an unapproved head stays queued with a visible `monitor.log` line, and a
  failed launch is never a silent drop — it stays queued for retry and
  raises a durable `sdlc_queue_launch` wake. The relaunch replays the
  record's own `execPath`/`execArgv` (not the enforcing process's), so a
  queued relaunch stays correct even under a differently-invoked daemon.
  `status --queue` lists queued entries. This is the interim consumer; the
  PRD-0020 daemon later owns the same queue via its watch registry against
  this unchanged record format.

- **sdlc-workflow:** the envelope gate's `maxDiffLines` budget now excludes
  test files (`*.test.*`, `*.spec.*`, `__tests__/**`, `__mocks__/**` —
  `isTestPath`) from the size count; they still count for `allowedPaths` /
  `forbiddenSurfaces`. A thorough test suite is not a bigger blast radius
  than a thin one, and counting it the same as production code was forcing
  a choice between under-testing and inflating envelopes (caught live on
  SPEC-BUG-retro-and-queued-plans-P1 T-02: 1187 total lines breached a
  600-line budget, but only 626 were non-test). The reviewer prompt's
  envelope section states the same exemption so the LLM reviewer's
  independent size judgment matches the mechanical gate.

- **sdlc-workflow:** gate verdicts are now linked to their eventual outcome
  so per-gate precision is computable from the Chronicle ledger
  (SPEC-BUG-reviewer-house-bar-P1 T-02). `record-merge --task` annotates
  the merged task's gate verdicts `outcome: stood`; `check-veto`'s revert
  path annotates the reverted tasks' verdicts `outcome: vetoed`. Each
  annotation is a compact `sdlc.outcome.v1` artifact keyed by
  `(runId, taskId, gate)`, so a resumed run overwrites rather than
  duplicates. Read-side reporting (e.g. a precision report) is out of
  scope — this task only guarantees the data exists going forward.

- **sdlc-workflow:** the reviewer prompt now injects the target repo's
  optional `.sdlc/review-checklist.md` (SPEC-BUG-reviewer-house-bar-P1
  T-01), resolved from the judged tree via `ReviewChecklistRepository`
  (T-03 tree-resolution rule). The assessment schema gains per-item
  `checklistFindings`, and a failed `mandatory` item overrides a
  concurring verdict to disagree. No file → unchanged pre-checklist
  prompt/verdict shape; a malformed checklist fails loud with a named
  `CONTRACT_MALFORMED` error. The engine ships no checklist content.

- **ci:** `.github/workflows/ci.yml`'s `test` job now runs `bun run typecheck`
  (`tsc --noEmit`) for `team-setup` and `sdlc-workflow`, each before that
  package's `test:coverage` step (SPEC-BUG-ci-typecheck-gate-P1 T-01). Jest
  runs through `@swc/jest`, which strips TypeScript types without checking
  them, so a `tsc`-only defect (duplicate object property, mismatched type,
  missing interface member) could ride onto `main` with CI green the whole
  time. The new step fails the build fast on that class of error instead of
  requiring someone to run `bun run build` by hand to notice.

- **sdlc-workflow:** synthesized `allowedPaths` are grounded in the target
  repo tree instead of trusted as LLM guesses (#35 /
  SPEC-BUG-envelope-spec-integrity-P1 T-01). At `decompose`, every envelope
  glob must match at least one existing path in the `--repo` checkout or be
  justified as a new-path intent (a task naming the file it creates in its
  engineering notes); anything else fails synthesis with
  `ENVELOPE_UNGROUNDED` listing the offending globs. A diff-forecast
  heuristic additionally warns — without blocking — when task engineering
  notes reference a path outside the envelope, so the human reviews a
  coherent envelope instead of discovering the gap as a mid-run breach.

- **sdlc-workflow:** `forbiddenSurfaces` fail closed at synthesis (#36 /
  SPEC-BUG-envelope-spec-integrity-P1 T-02). `decompose` resolves every
  synthesized surface label against the target repo's `.sdlc/surfaces.json`
  and aborts with `SURFACE_UNRESOLVABLE` — each unresolvable label named and
  the repo's known labels listed — instead of letting a label no gate can
  enforce ship (or vanish) before a human reviews the spec. The known labels
  are also fed into the synthesis prompt so the model picks from real
  surfaces. Specs whose labels all resolve render byte-identically to prior
  behavior, and arbitrary consumer labels (e.g.
  `regulated-data-boundary`) round-trip PRD → spec → intake without loss.- **sdlc-workflow:** the envelope gate resolves `.sdlc/surfaces.json` from
  the git tree under judgment (the task PR tip) via
  `SurfaceMapRepository.loadAtRef`, never the operator's local checkout — a
  locally edited (uncommitted) contract can no longer sway a verdict. A
  contract missing from the judged tree while the envelope declares
  `forbiddenSurfaces` is now a named breach reason (contract path + judged
  ref), not a local-file fallback. README documents the tree-resolution
  rule and audits the other evaluation-time `.sdlc/` readers (sandbox /
  verification contracts load from the task worktree, which is the judged
  tree's checkout) (SPEC-BUG-envelope-spec-integrity-P1 T-03).

- **sdlc-workflow:** two integrity guards on the spec file itself (#40 /
  SPEC-BUG-envelope-spec-integrity-P1 T-04). The envelope gate now pins the
  self-ticking regression end-to-end: a product-task diff that edits its own
  `specs/**` file — including flipping its acceptance checkboxes — hard-breaches
  even when `allowedPaths` explicitly covers the spec path; checkbox / `status:`
  closeout has a single writer, the engine closeout / docs PR after the product
  tasks merge (PRD-0023). Added `sdlc-workflow spec-lint --spec <path>`:
  validates front-matter parse, envelope schema + inline-array integrity, and
  checkbox integrity (criteria present, tiers recognized) with named
  `SPEC_MALFORMED` / `SPEC_INVALID` errors — no LLM call, no `--repo`, hook/CI
  safe. It is the guard that catches a formatter-reshaped envelope (the Prettier
  incident: a folded YAML block sequence the tolerant parser mis-joins into one
  garbage glob) before intake silently accepts it.

- **sdlc-workflow:** enforce-merge reconciles a thrown `gh pr merge` against
  GitHub (`mergeCommit.oid`) before filing `merge-blocked`. A
  `--delete-branch` false negative with the task branch still checked out
  in the run worktree now records the real `mergedSha` and unblocks the
  phase gate instead of posting a spurious needs-human
  (SPEC-BUG-fail-loud-run-lifecycle-P1 T-03; entry deferred from the task
  PR for envelope compliance).

- **sdlc-workflow:** needs-human escalations are assigned and delivered, not
  parked. `run --operator <login>` (or `SDLC_OPERATOR`) assigns the GitHub
  issue created for each exception entry; without an operator the issue still
  posts and `monitor.log` warns. Every escalation also emits one durable
  wake-inbox event (title-idempotent across resume) alongside the existing
  queue item. Swallowed `gh issue create` failures append a loud
  `monitor.log` warning while the run continues
  (SPEC-BUG-fail-loud-run-lifecycle-P1 T-04).

- **sdlc-workflow:** supervise / detached children install exit traps so any
  trappable termination (clean exit, thrown error, SIGTERM/SIGINT) writes
  `supervise.exit` (`code` + `reason` + `abnormal`), a terminal
  `monitor.log` line, and a durable `sdlc_supervisor` wake (#38 /
  SPEC-BUG-fail-loud-run-lifecycle-P1 T-02). Abnormal zero-exits
  (incomplete tasks) are distinguishable from all-merged completion in
  artifacts alone. SIGKILL / power-loss stay with the continuity daemon's
  liveness check — documented in the README detection boundary. Detach
  parents still exit non-zero when the child dies during startup (missing
  spec / refused intake).

- **sdlc-workflow:** persist `state.json` at run invocation start — before
  intake completes and before the first step-cache boundary — so a crash
  never leaves `status --run-id` answering `RUN_NOT_FOUND` (#37 /
  SPEC-BUG-fail-loud-run-lifecycle-P1 T-01). Launch record carries run id,
  spec path/digest, base SHA, launch argv, `startedAt`, and an empty step
  map. Refused intake still records the blocked verdict and exits non-zero;
  supervise clears its `supervise.pid` on clean exit so the continuity
  daemon does not treat a terminal refusal as a relaunchable half-run.

- **team-setup / Addi merge-on-approve:** after merging a PR that touches
  `specs/**/phase-*-spec.md`, emit `repository_dispatch` type
  `sdlc-run-launch` with `client_payload: { specPaths, mergedSha, prNumber }`
  exactly once per merge SHA (commit-status dedup). Non-spec merges emit
  nothing. Script: `team-setup/scripts/emit-sdlc-run-launch.mjs`
  (SPEC-BUG-one-click-spec-approval-P1 T-02).

- **team-setup / Addi merge-on-approve:** on Approve of an Addi PR that
  touches Draft `specs/**/phase-*-spec.md`, push a DCO-signed
  `docs(spec): approve SPEC-… on human Approve` flip (Addi App) before
  merge. Script: `team-setup/scripts/flip-spec-status.mjs`. Non-spec PRs
  unchanged (SPEC-BUG-one-click-spec-approval-P1 T-01).

- **sdlc-workflow:** enforce intake / supervise re-read the Approved spec from
  `origin/<defaultBranch>` (`SpecDocRepository.readAtRef`) instead of comparing
  the operator working tree to origin. Stale local checkbox edits no longer
  block the next wave after a merge moves the origin blob. The envelope gate
  hard-breaches any path under `specs/**` (even if listed in `allowedPaths`);
  implementation and reviewer prompts ban mid-run spec / AC / `status:` edits.
  Blocked intake CLI output now prints `pool.detail` and verdict reasons
  instead of always saying `unapproved-spec`.

- **team-setup:** continuity daemon one-shot syncs the launch.json spec file
  from origin before relaunch when recent intake evidence shows
  `spec-not-merged` / “differs from origin” (safety net for older engines).

- **team-setup:** `sdlc-continuity-daemon.sh` no longer reports a supervisor
  that exited cleanly (exit code 0) as "died during startup." `--supervise`
  finishes its own process the moment a wave has nothing left to do —
  including the moment it discovers a task is blocked on a needs-human
  gate — and that can legitimately happen well inside the post-relaunch
  probe window. The daemon used to treat that fast exit as a crash, fire a
  misleading "relaunch failed" wake, delete the pid file, and then never try
  again (the outer tick loop only re-attempts a relaunch when the pid file
  is non-empty). The relaunch wrapper now captures the real exit code via a
  `supervise.exit` sidecar and only reports a crash when that code is
  nonzero. The daemon also now checks `blockers --json` before attempting a
  relaunch at all: a run with an open, uncleared needs-human blocker is
  skipped outright rather than respawned every 60s just to reconfirm the
  same block. Found live: a canary run's supervisor legitimately exited
  twice after hitting a blocked gate, both attempted relaunches were
  misreported as startup crashes, and the resulting wake sat unconsumed in
  the local inbox with nobody watching.

- **team-setup:** `wake-inbox.sh`'s `wake_emit` now fires a native macOS
  notification banner (`osascript display notification`) alongside the
  existing pending-file write, best-effort and non-blocking. The durable
  file was already reachable by the Cursor stop hook, but that hook only
  drains on the next turn boundary — a wake created while chat is fully
  idle had no path to a human until they happened to start a new turn on
  their own. The system notification reaches the human directly and closes
  that idle-chat gap. Found live: a daemon relaunch-failed wake sat in
  `~/.rosetta/wake/pending` for 30+ minutes during idle chat with nobody
  alerted.

- **sdlc-workflow:** task worktrees are now cleaned up automatically once
  their work has actually merged. `GitRepository.removeWorktreeAsync`
  dispatches `git worktree remove --force` without waiting for it —
  fire-and-forget, so a locked file or slow removal can never block run
  progress or turn a landed merge into a reported failure. Wired into both
  merge paths: the engine's own enforcing-mode merge, and `record-merge`
  (now accepting an optional `--repo`) for merges acknowledged externally
  (e.g. a human Approve that GHA merged). Closes the manual
  `git worktree prune` cleanup this session kept needing by hand.

- **team-setup:** add `/write-bug-spec` command and
  `rosetta_docs/product/BUG-SPEC-TEMPLATE.md` — a lightweight entry point
  into the spec-run-verify-merge machine for bugs that skips the PRD and
  `decompose` steps entirely. The engine's atomic unit is the Approved spec,
  not the PRD; `decompose` is only one way to produce one, and forcing a
  single-task bug fix through PRD-shaped Goals/Non-Goals/Rollout ceremony
  and an LLM decompose call was needless overhead. Hand-author a minimal
  spec (synthetic `prd: BUG-<slug>` label, one task, tight envelope) instead
  and run it through the identical `sdlc-workflow run` — same envelope gate,
  verification, reviewer, sandbox, and provenance checks a feature gets.
  Reserved for non-trivial or blast-radius-sensitive bugs; a genuinely
  trivial one-liner still doesn't need the machine.

- **addi-authorship rule:** documented a recurring false-positive permission
  error. `gh pr create`/`gh issue create` without an explicit `--repo`
  default to targeting a forked repo's upstream parent, not `origin` — on
  a consumer fork of `rosetta_dev-scripts` (forked from
  `Rosetta-Foundation/rosetta_dev-scripts`) this produced `GraphQL: Resource
not accessible by integration (createPullRequest)`, indistinguishable
  from Addi genuinely lacking `pull_requests: write`, which it does not.
  Confirmed live: REST `POST /pulls` and a raw GraphQL `createPullRequest`
  both pass the permission check on the same token; only `gh pr create`'s
  default fork-upstream resolution failed. Fix is `--repo <owner>/<repo>`,
  not a permission grant.

- **sdlc-workflow:** closed the "acceptance criteria" transparency gap
  identified while coaching PRD/spec authoring: all `test:` criteria on a
  task share a single run of the repo's scripted verify command, so a
  failure was previously reported as N independent `failed: <criterion>`
  reasons — misrepresenting one root cause as several to anyone reading a
  needs-human issue, `blockers` output, or the PR body. `VerificationService`
  now groups criteria that share an `evidenceId` into one reason
  (`failed (1 shared check, evidence <id>, covers N criteria): ...`);
  agent-tier criteria, which each get their own `evidenceId`, are
  unaffected. The generated PR body also now adds a note whenever a task
  declares 2+ `test:` criteria, telling the reviewer up front that they
  collapse into one check rather than N independent assertions.

- **sdlc-workflow:** the PRD parser now fails loudly and specifically instead
  of silently degrading. `prd-parser.ts` required exact heading text/numbering
  (`### 1.2 Goals`, an em-dash-only Rollout phase format) and returned empty
  arrays on any mismatch — a hand-authored or agent-authored PRD that drifted
  even slightly from that microformat produced no error, just a PRD that
  quietly decomposed into worse (or, for empty goals, eventually-erroring)
  output with no indication why. Sweeping this against every real PRD in
  `rosetta_docs/product/` surfaced that even the _authoritative_
  `TEMPLATE.md` and the engine's own founding `PRD-0011` don't match the old
  strict Rollout regex (template puts the title outside the bold span;
  PRD-0011 prefixes phases with a status emoji) — proof the old contract was
  unworkable in practice, not just strict. Required sections (Goals,
  Acceptance Criteria, Rollout) now throw a `PRD_MALFORMED` error naming the
  exact missing heading the moment a heading truly isn't found, while Rollout
  phase parsing itself became more permissive: it accepts either dash type
  (—/-), a title inside or outside the bold span, and an optional
  emoji/status marker, and correctly captures multi-line wrapped
  descriptions (a separate, previously-silent bug: the old lazy-match
  lookahead terminated at the end of a phase's first line, truncating or
  dropping any phase whose description wrapped). Added `sdlc-workflow
prd-lint --prd <id> --docs-dir <dir>` — validates a PRD parses cleanly with
  no LLM call and no `--repo`, for fast feedback right after drafting, before
  `decompose` ever runs.

- **sdlc-workflow:** sandbox deploy and test-tier verification now run
  concurrently instead of sequentially. `ShellCommandRepository` used
  `spawnSync`, which blocks Node's single thread — so even though the
  test-tier scripted check (`yarn typecheck`/`test`/`build`) has no
  dependency on the deployed sandbox, it could never overlap with the
  deploy. Switched to async `spawn`, and `run.handler.ts` now dispatches
  `sandboxStep` and `VerificationService.verifyTestTierOnly` together via
  `Promise.all`; only agent-tier criteria (which consume the sandbox health
  report) still wait for the deploy to finish. Measured against a live run:
  cuts ~1.5–2 minutes off the deploy-finishes-to-merge gap per deployable
  task. CI is unaffected — it already overlaps for free since GitHub
  Actions triggers the moment the PR opens.

- **sdlc-workflow:** `run --supervise --detach` works from a source checkout
  again. The detached child was spawned as `process.execPath` plus the argv,
  dropping the interpreter flags — running from source that is plain node and
  a `.ts` entry, so the child died on `ERR_UNKNOWN_FILE_EXTENSION` before its
  first wave. `process.execArgv` is now replayed into the child.

- **team-setup:** the continuity daemon replays `execArgv` when relaunching a
  supervisor (falling back to `tsx` for launch records written without it) and
  probes the child before reporting a restart, so a relaunch that dies at
  startup escalates instead of waking the operator to "confirm progress" on a
  process that never ran.

- **team-setup:** the continuity daemon no longer re-logs and re-kills a
  stalled agent on every 60s tick. A killed agent never touches its heartbeat
  again, so the condition is permanent once detected; the kill now fires once
  per condition, matching the wake.

- **sdlc-workflow:** `run --detach` no longer reports success when the child
  dies during startup. It printed `[supervise] detached` and exited 0 as soon
  as the spawn returned, so a bad `--spec` path, a still-`Draft` spec, or a
  non-worktree `--repo` looked identical to a healthy launch — and no
  `state.json` exists that early, so the continuity daemon skipped the run too.
  The parent now probes the child after a startup grace and, if it is gone,
  surfaces the tail of the child's own log and exits 1.

- **team-setup:** deploy dual-tenant `addi-merge-webhook` to an AWS Lambda Function
  URL; consumer-org and Rosetta org webhooks deliver
  `pull_request_review` → `repository_dispatch` (`addi-merge-on-approve`).

- **team-setup:** remove `attribution` from project `.cursor/cli.json` — Cursor
  only allows `permissions` at project scope; `attribution` belongs in
  `~/.cursor/cli-config.json` and was failing Agent CLI schema validation.

- **team-setup:** `update-config` now targets the workspace enclosing the cwd
  before falling back to `shared.baseDir`. Every checkout ships the same
  hard-coded `baseDir`, so running it from a second workspace silently rewrote
  the first — the two workspaces drifted while both appeared synced.

- **team-setup:** `pr-approve-watch` also wakes on human **Request changes**
  (`signal: changes_requested` in the wake JSON) — once per new non-bot review
  id — so feedback can stay on the PR; agent fixes without merging and keeps
  watching until Approve.

- **team-setup:** Addi merge-on-approve uses GitHub **`merge-async`** for
  native stacked PRs (`pull.stack`); plain `gh pr merge` is rejected on stacks.
  Conflicts on a lower PR still require an agent resolve (GHA comments only).

- **team-setup:** gold-standard **Addi PR automation** —
  `docs/addi-pr-automation-standard.md` + hardened
  `addi-merge-on-approve.yml` (repository_dispatch / workflow_run / schedule)
  - `addi-merge-webhook` bridge; `pr-approve-watch` demoted to triage when GHA
    is enabled. Each organization uses its own Addi App Client ID + PEM
    under the same Action variable names.

- **team-setup:** add `addi-authorship` rule — agent PRs/issues must be created
  as the workspace GitHub App (Addi); verify `viewer.login` before create; never
  fall back to human `gh` on 403; recreate accidental human-authored PRs as Addi.

- **team-setup:** add `deploy-verify-watch` skill — classify live-verify PRs
  (auth / multi-SPA / Deploy Org paths), auto-dispatch the deploy workflow on
  each new head SHA, and wake on `deploy_green` / `deploy_failed` so humans
  re-smoke before Approve; `/watch-deploy-verify` + always-on rule. Pair with
  `pr-approve-watch`.

- **team-setup:** Addi merge-on-approve uses `client-id` (`ADDI_CLIENT_ID`) instead of deprecated `app-id`.

- **team-setup:** fix Addi merge-on-approve self-deadlock — do not `gh pr checks --watch` our own pending check on `pull_request_review`.

- **team-setup:** prove Addi merge-on-approve clean path v2 (Approve → bot squash-merge via GHA schedule).

- **team-setup:** prove Addi merge-on-approve GHA path (human Approve → `rosetta-s-addi-m[bot]` squash-merge).

- **team-setup:** spike **Addi merge-on-approve** via GitHub Actions (preserves
  `rosetta-s-addi-m[bot]` identity). Cursor Automations cannot run as Addi —
  see `team-setup/docs/addi-merge-on-approve-spike.md` + opt-in workflow
  `.github/workflows/addi-merge-on-approve.yml`.

- **team-setup:** document watch wake **delivery gap** — Cursor
  `notify_on_output` is best-effort after the arming turn ends; agents must
  drain `AGENT_LOOP_WAKE_*` from watcher terminals (and treat “I approved” /
  “check watchers” as a drain nudge). Applies to `pr-approve-watch` and
  `issue-resolve-watch` skills/rules/commands + wake prompts.

- **team-setup:** `pr-approve-watch` wake path must resolve `mergeable=CONFLICTING` PRs (rebase/merge onto base, push, re-check CI) before comment triage + merge — do not stop after Approve on a dirty tip.

- **team-setup:** add `issue-resolve-watch` skill — background-watch GitHub
  issues (kickoff / human comments / linked PRs / closed) and wake the agent
  to drive Done-when → close; `/watch-issue-resolve` + always-on rule.

- **team-setup:** ban Cursor/tool marketing footers in commits and PR bodies
  (`no-tool-attribution` rule + `attribution` opt-out in global
  `cli-config.json`); agents must strip injected "Made with Cursor"
  via `gh pr edit` if the client still appends it.

- **team-setup:** add `pr-approve-watch` skill/rule/command — background-watch
  PRs for a human GitHub Approve proceed signal (`AGENT_LOOP_WAKE_pr_approve`),
  then merge and continue. Works for Rosetta (`~/.config/rosetta/…`) and consumer
  workspace (`~/.config/<workspace>/…`) activate scripts.

- **sdlc-workflow:** supervise fails fast on enforce `merge-blocked` (no spurious
  "no ready task" wave); gate logs label `[enforce]` vs `[shadow]`; monitor notes
  when the heartbeat watch stops.

- **sdlc-workflow:** `run --supervise` auto-resumes dependency waves and mirrors
  heartbeats to `monitor.log`; `run --detach` spawns a detached supervise child
  that survives agent shell teardown (#38 / #39). See
  `sdlc-workflow/docs/operator-background-supervise.md`. Likely future default
  for `--supervise`; opt-in today.

- **team-setup:** add `inline-docs` agent rule (TSDoc/JSDoc bar for HSR + frontend);
  link it from `architecture-hsr`; mirror description in Cursor `.mdc` generation.

- **sdlc-workflow:** reviewer prompt includes the documentation bar checklist so
  shadow/enforce reviews catch missing or hollow docs on new exports.

- **sdlc-workflow:** bug-fix runs now feed their own retro back into intake
  instead of ending at merge. For a `SPEC-BUG-*` spec, the phase boundary
  that posts the T-07 digest also dispatches one inference call over the
  spec's Context section and the run's verdict/exception history, asking
  what would have caught the bug earlier and which stage should own that
  check. Recommendations commit as one `sdlc.retro.v1` artifact and link
  from a `[retro]`-tagged queue Inbox item. Idempotent across resume;
  non-`BUG-*` runs unaffected; a model failure degrades
  loud-but-nonblocking with a `[retro] WARNING` in `monitor.log`
  (SPEC-BUG-retro-and-queued-plans-P1 T-01).

## 1.0.0

- Initial release: `team-setup` CLI for the Rosetta workspace with setup, verify, tracks,
  shell-alias, and update-config commands.
- Flat workspace layout — `rosetta_chronicle` and `rosetta_wayfinder` configured as `flatRepos`.
- Templates enforce the Handler / Service / Repository + InversifyJS architecture
  (`.claude/rules/architecture-hsr.md`), Conventional Commits, and the Copilot / CI review cycles.
- Adapted from the AI Ops `dev-scripts` team-setup tooling.
