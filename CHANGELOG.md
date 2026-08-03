# Changelog

## Unreleased

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
