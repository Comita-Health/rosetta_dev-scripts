# Changelog

## Unreleased

- **sdlc-workflow:** the envelope gate resolves `.sdlc/surfaces.json` from
  the git tree under judgment (the task PR tip) via
  `SurfaceMapRepository.loadAtRef`, never the operator's local checkout — a
  locally edited (uncommitted) contract can no longer sway a verdict. A
  contract missing from the judged tree while the envelope declares
  `forbiddenSurfaces` is now a named breach reason (contract path + judged
  ref), not a local-file fallback. README documents the tree-resolution
  rule and audits the other evaluation-time `.sdlc/` readers (sandbox /
  verification contracts load from the task worktree, which is the judged
  tree's checkout) (SPEC-BUG-envelope-spec-integrity-P1 T-03).

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
  `Comita-Health/rosetta_dev-scripts` (forked from
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
  `rosetta_docs/product/` surfaced that even the *authoritative*
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
- **team-setup:** deploy dual-tenant `addi-merge-webhook` to AWS Lambda Function
  URL (`comita-dev`); Comita + Rosetta org webhooks deliver
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
  + `addi-merge-webhook` bridge; `pr-approve-watch` demoted to triage when GHA
  is enabled. Comita and Rosetta each use their own Addi App Client ID + PEM
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
  then merge and continue. Works for Rosetta (`~/.config/rosetta/…`) and Comita
  (`~/.config/comita/…`) activate scripts.
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

## 1.0.0

- Initial release: `team-setup` CLI for the Rosetta workspace with setup, verify, tracks,
  shell-alias, and update-config commands.
- Flat workspace layout — `rosetta_chronicle` and `rosetta_wayfinder` configured as `flatRepos`.
- Templates enforce the Handler / Service / Repository + InversifyJS architecture
  (`.claude/rules/architecture-hsr.md`), Conventional Commits, and the Copilot / CI review cycles.
- Adapted from the AI Ops `dev-scripts` team-setup tooling.
