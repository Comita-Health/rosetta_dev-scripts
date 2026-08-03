# Changelog

## Unreleased

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
- **sdlc-workflow / team-setup:** the continuity daemon could never actually
  restart anything, and said it had. Launch records stored `execPath` (plain
  node) plus a `.ts` entry but not the interpreter flags, so every relaunch —
  and every `run --supervise --detach` from a source checkout — died on
  `ERR_UNKNOWN_FILE_EXTENSION` before reading a byte. The daemon then wrote the
  corpse's pid, logged "relaunched", and woke the operator to "confirm it is
  making progress". Launch records now carry `execArgv` and both the detach
  path and the daemon replay it (records already on disk fall back to `tsx`),
  and the daemon probes the child before claiming a restart, escalating a
  distinct wake when it dies immediately.
- **team-setup:** the continuity daemon no longer re-logs and re-kills a
  stalled agent on every 60s tick. A killed agent never touches its heartbeat
  again, so the condition is permanent once detected — one abandoned run
  emitted 800 "stalled — killing" lines over 13 hours, burying every other
  run. The kill now happens once per condition, matching the wake.
- **sdlc-workflow:** enforcing-mode merges no longer fail on every task. The
  merge ran `gh pr merge --squash --delete-branch`, and the engine only ever
  merges a branch checked out in one of its own worktrees, so gh always failed
  the *local* delete — after the merge had already landed. Every task reported
  `merge failed`, filed a needs-human issue, and held the phase gate behind
  work that was in fact on the default branch. `--delete-branch` is dropped
  (repos set `delete_branch_on_merge`), and a merge command that exits non-zero
  is now reconciled against real PR state before it is called a failure.
- **sdlc-workflow:** `run --detach` no longer reports success when the child
  dies during startup. It printed `[supervise] detached` and exited 0 as soon
  as the spawn returned, so a bad `--spec` path, a still-`Draft` spec, or a
  non-worktree `--repo` looked identical to a healthy launch — and no
  `state.json` exists that early, so the continuity daemon skipped the run too.
  The parent now probes the child after a startup grace and, if it is gone,
  surfaces the tail of the child's own log and exits 1.
- **sdlc-workflow:** SPEC-PRD-0011-P4 path-aware sandbox deploy. The sandbox
  gate now exports `SDLC_SANDBOX_BASE_SHA` (the task's gate base; the run's
  frozen base at the phase boundary) alongside `SDLC_SANDBOX_SHA`, so
  repo-owned deploy scripts can diff `base..head` and skip or thin out the
  ship. The engine stays path-agnostic — policy lives in the target repo.
  First consumer: `comita_admissions`, where a docs-and-tests-only task used
  to pay a full backend + frontend AWS deploy.
- **team-setup:** remove `attribution` from project `.cursor/cli.json` — Cursor
  only allows `permissions` at project scope; `attribution` belongs in
  `~/.cursor/cli-config.json` and was failing Agent CLI schema validation.
- **team-setup:** `update-config` now targets the workspace enclosing the cwd
  before falling back to `shared.baseDir`. Every checkout ships the same
  hard-coded `baseDir`, so running it from a second workspace silently rewrote
  the first — the two workspaces drifted while both appeared synced.
- **team-setup:** Addi merge-on-approve uses GitHub **`merge-async`** for
  native stacked PRs (`pull.stack`); plain `gh pr merge` is rejected on stacks.
  Conflicts on a lower PR still require an agent resolve (GHA comments only).
- **team-setup:** `pr-approve-watch` also wakes on human **Request changes**
  (`signal: changes_requested` in the wake JSON) — once per new non-bot review
  id — so feedback can stay on the PR; agent fixes without merging and keeps
  watching until Approve.
- **team-setup:** Addi merge-on-approve uses **merge commits** for stacked PRs
  (base ≠ default branch); squash only onto the default branch. Conflict path
  stays comment-only — agents resolve; documented in the gold-standard table.
- **team-setup:** Comita rollout of Addi merge-on-approve (org `ADDI_CLIENT_ID` / `ADDI_APP_PRIVATE_KEY` for Comita Addi App `addi-m`).
- **team-setup:** gold-standard **Addi PR automation** —
  `docs/addi-pr-automation-standard.md` + hardened
  `addi-merge-on-approve.yml` (repository_dispatch / workflow_run / schedule)
  - `addi-merge-webhook` bridge; `pr-approve-watch` demoted to triage when GHA
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
  (`no-tool-attribution` rule + `attribution.attributePRsToAgent: false` in
  workspace `.cursor/cli.json`); agents must strip injected "Made with Cursor"
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
