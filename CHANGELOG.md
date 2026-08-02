# Changelog

## Unreleased

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
