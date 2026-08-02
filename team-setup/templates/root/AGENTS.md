# Comita Health — Agent instructions (Cursor + Claude Code)

This **Comita Health LLC** workspace is set up for **both** Cursor Agent/CLI
and Claude Code, using Rosetta as the engineering memory methodology.

## Canonical brief

Read [`CLAUDE.md`](./CLAUDE.md) first. Cursor Agent and the Cursor CLI load
`CLAUDE.md` automatically; Claude Code does too. Keep that file as the source of
truth for workflow, git conventions, and architecture pointers.

## Tool-specific layout

| Concern              | Claude Code                                                                                 | Cursor Agent / CLI                                                                                    |
| -------------------- | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Project brief        | `CLAUDE.md`                                                                                 | `CLAUDE.md` + this `AGENTS.md`                                                                        |
| Architecture / style | `.claude/rules/`                                                                            | `.cursor/rules/*.mdc` (mirrored on setup)                                                             |
| Permissions          | `.claude/settings.json`                                                                     | `.cursor/cli.json`                                                                                    |
| Slash-style prompts  | `.claude/commands/` (`/review`, `/add-repo`, `/sdlc-status`, `/prd-portfolio`, `/sdlc-run`) | Matching `.cursor/rules/command-*.mdc` — ask the agent to follow them                                 |
| Agent skills         | `.claude/skills/`                                                                           | `.cursor/skills/` (e.g. `sdlc-run-supervise` for background runs, `sdlc-prd-progress` for scorecards) |

## Quick start

**Cursor IDE:** open `all.code-workspace` (or this folder) → Agent (`Cmd+I`).

**Cursor CLI:** from the workspace root:

```bash
agent
# or
agent "summarize the Comita and Rosetta repos in this workspace"
```

**Claude Code:** open this folder in Claude Code as usual.

You need **at least one** of Cursor Agent/CLI or Claude Code to contribute with
AI assistance. Git hooks and Conventional Commits apply regardless of agent.

## Git defaults

- Branch from up-to-date `main` using `f/` (feature) or `b/` (bug).
- **Do not commit on `main`** unless a human explicitly authorizes a documented exception
  (foundation bootstrap or emergency hotfix — see `CLAUDE.md`).
- Conventional Commits are enforced by husky `commit-msg` in every Rosetta repo.
- **No “Made with Cursor” (or similar) in commits or PR descriptions** — see
  `.claude/rules/no-tool-attribution.md` / `.cursor/rules/no-tool-attribution.mdc`.
- **Watched issues drive to resolution** — see `issue-resolve-watch`
  (`/watch-issue-resolve`); arm after taking ownership (recreate as Addi when
  asked).
- **Live-verify PRs redeploy on push** — see `deploy-verify-watch`
  (`/watch-deploy-verify`); arm for auth/multi-SPA/deploy-path PRs so each head
  SHA dispatches a host deploy and wakes for human re-smoke before Approve.
- **PRs and issues as Addi** — activate the workspace GitHub App before
  `gh pr create` / `gh issue create`; never open them as the human `gh` user
  (humans must Approve Addi PRs). See `addi-authorship`.
