# rosetta_dev-scripts

CLI to bootstrap and maintain the **Rosetta** workspace. Clones all repos, creates the directory
structure, and lays down **Claude Code + Cursor Agent/CLI** configuration so contributors can use
either (or both) AI coding agents with the same architecture rules and git conventions.

Rosetta is an AI-native engineering knowledge platform — a shared memory layer for people, projects,
and AI. Chronicle is the memory; Wayfinder is the guide.

This repo hosts two workspace packages:

- [`team-setup/`](./team-setup) — the bootstrap + maintenance CLI described below.
- [`sdlc-workflow/`](./sdlc-workflow) — PRD-0011 full-loop SDLC automation: decompose a
  PRD into an implementation spec, then execute the Approved spec end to end — parallel
  task worktrees, five machine gates, auto-merge on green, sandbox deploy, Chronicle
  artifacts, and a generated closeout PR that ticks the spec from recorded verdicts. A
  human approves the spec and smokes the sandbox; the rest is machine-owned. See its
  [README](./sdlc-workflow/README.md) for the engine and
  [`rosetta_docs/architecture/sdlc/`](https://github.com/Rosetta-Foundation/rosetta_docs/tree/main/architecture/sdlc)
  for the architecture reference with diagrams.

## Why Use Team Setup?

Team Setup gives every engineer a consistent, batteries-included agent environment from day one.
Instead of each person configuring their own rules, permissions, and workflows, everyone gets the
same guardrails — whether they work in Claude Code, Cursor Agent, or the Cursor CLI.

### What You Get

**Dual agent support** — Workspace root gets:

- `CLAUDE.md` + `.claude/` (settings, slash commands, rules, skills) for Claude Code
- `AGENTS.md` + `.cursor/cli.json` + `.cursor/rules/*.mdc` + `.cursor/skills/` for
  Cursor Agent/CLI (rules/commands are mirrored from `.claude/` so content does
  not drift; skills ship under both `.claude/skills/` and `.cursor/skills/`)

**Enforced architecture** — Handler / Service / Repository + InversifyJS for all TypeScript, via
`.claude/rules/architecture-hsr.md` and the mirrored `.cursor/rules/architecture-hsr.mdc`.

**Automated PR lifecycle** — Push, open a PR, and let the agent handle the rest:

- Automatic Copilot review processing: reads comments, fixes valid issues, replies with commit SHAs, resolves threads
- Automatic CI checks monitoring: detects failures, reads logs, diagnoses and fixes issues, re-pushes — loops up to 3 times before escalating to a human
- Both cycles run in parallel after every push

**Enforced commit conventions** — Conventional Commits via husky `commit-msg` in **every**
Rosetta repo (`rosetta_docs`, `rosetta_dev-scripts`, `rosetta_chronicle`, `rosetta_wayfinder`):

- Automatic ticket scope extraction from branch names (e.g. `f/PROJ-123-foo` produces `feat(PROJ-123): ...`)
- Consistent types: `feat`, `fix`, `chore`, `docs`, `refactor`, `perf`, `test`, `build`, `ci`, `revert`
- Breaking change notation with `!` suffix
- **Default: no commits on `main`** — use `f/` / `b/` + PR. Exceptions (foundation bootstrap,
  emergency hotfix) require explicit human authorization; see workspace `CLAUDE.md`.

**Safe-by-default permissions** — Pre-configured allow/deny lists for Claude (`.claude/settings.json`)
and Cursor CLI (`.cursor/cli.json`) so agents can:

- Read, edit, and write files freely (except secrets like `.env`)
- Run git, bun, node, gh CLI commands without prompting
- Never force-push, `reset --hard`, or `rm -rf` critical paths

**Shared code style rules** — TypeScript strict mode, Prettier conventions, and import hygiene applied uniformly across all repos in the workspace.

**Slash commands / agent prompts out of the box:**

- Claude Code: `/review`, `/add-repo`, `/sdlc-status` under `.claude/commands/`
- Cursor: matching `command-review` / `command-add-repo` / `command-sdlc-status`
  rules under `.cursor/rules/` — ask the agent to follow them
- Skills: `sdlc-prd-progress` (PRD/spec shadow-run scorecard — where a PRD is in
  `sdlc-workflow` implementation) and `pr-approve-watch` (Approve or Request
  changes wake + review-comment triage; merge only on Approve) under
  `.cursor/skills/` and `.claude/skills/`

**Multi-repo workspace** — One bootstrap gives you:

- All Rosetta repos cloned into a flat workspace
- VS Code / Cursor multi-root workspace file (`all.code-workspace`)
- `gotor` fuzzy-navigation alias for quick repo switching
- Root agent docs so Claude Code and Cursor understand the full landscape

### Adapting for Another Workspace

The setup is template-driven. To adopt this for a different workspace:

1. Fork this repo
2. Edit `team-setup/src/config/shared.json` (org, baseDir, `flatRepos`) and `tracks/default.json`
3. Replace `team-setup/templates/` content with your conventions
4. Update the `gotor` alias name/marker/path in `team-setup/src/index.ts` and `ORG`/`REPO`/`DEST` in `bootstrap.sh`
5. Your team runs the same one-line bootstrap

Agent docs, rules, commands, and settings are version-controlled files — refresh with `update-config`
when templates change.

---

## New Team Member Setup

### Prerequisites

- [GitHub CLI](https://cli.github.com/) — `brew install gh` then `gh auth login`
- [Node.js 20+](https://github.com/nvm-sh/nvm) — `nvm install 20`
- [Bun 1.3+](https://bun.sh/) — `curl -fsSL https://bun.sh/install | bash`
- [fzf](https://github.com/junegunn/fzf) (optional) — `brew install fzf` (for the `gotor` alias)
- **At least one AI agent:**
  - [Claude Code](https://docs.anthropic.com/en/docs/claude-code), and/or
  - [Cursor Agent CLI](https://cursor.com/docs/cli/installation):
    ```bash
    curl https://cursor.com/install -fsS | bash
    # ensure ~/.local/bin is on PATH, then:
    agent login
    agent --version
    ```

### One-line bootstrap

Run:

```bash
bash <(gh api repos/Rosetta-Foundation/rosetta_dev-scripts/contents/bootstrap.sh -q '.content' | base64 -d)
```

That's it. The script will:

1. Clone this repo into `~/projects/rosetta/rosetta_dev-scripts`
2. Install dependencies
3. Create the workspace directory structure
4. Lay down Claude Code + Cursor agent config (`CLAUDE.md`, `AGENTS.md`, `.claude/`, `.cursor/`)
5. Generate `all.code-workspace` (open in VS Code or Cursor)
6. Print the `gotor` shell alias to add to your `~/.zshrc`

> The bootstrap runs setup with `--skip-clone`, so it scaffolds structure + config. Run
> `bun run dev -- setup` afterward (without `--skip-clone`) to clone the
> Rosetta repos and wire Chronicle session hooks for Claude Code and Cursor.

To use a custom destination instead of `~/projects/rosetta`:

```bash
bash <(gh api repos/Rosetta-Foundation/rosetta_dev-scripts/contents/bootstrap.sh -q '.content' | base64 -d) ~/work/rosetta
```

### After bootstrap

Add the printed `gotor` alias to your `~/.zshrc`, then:

```bash
source ~/.zshrc
gotor   # fuzzy-navigate to any Rosetta repo
```

**Cursor:** open `~/projects/rosetta/all.code-workspace` (or the folder) → Agent (`Cmd+I`), or from
the root run `agent`.

**Claude Code:** open the same workspace root as usual.

### Agent automation secrets (Slack + GitHub App)

After bootstrap, each engineer scaffolds `~/.config/<workspace>/` for local
agent credentials. **Shared** values (Slack bot) come from a team password
manager; **private** values (personal or org GitHub App PEM) stay per-person.

```bash
cd ~/projects/rosetta/rosetta_dev-scripts/team-setup   # or your workspace path
bun run dev -- scaffold-secrets --workspace comita --register-cursor-hook
# Prefer 1Password inject for shared Slack — see the walkthrough
bun run dev -- verify-secrets --workspace comita
```

Full walkthrough (safe sharing, personal bot naming, Cursor `sessionStart`):
[`team-setup/docs/workspace-agent-secrets.md`](./team-setup/docs/workspace-agent-secrets.md).

## Commands

Once bootstrapped, all commands run from inside `rosetta_dev-scripts/team-setup/`:

### `setup`

Full workspace bootstrap (what `bootstrap.sh` calls internally).

```bash
bun run dev -- setup

# Custom base directory
bun run dev -- setup --base-dir ~/work/rosetta

# Skip cloning (structure + config only)
bun run dev -- setup --skip-clone

# Skip bun install
bun run dev -- setup --skip-install
```

### `update-config`

Refresh agent config files (`CLAUDE.md`, `AGENTS.md`, `.claude/`, `.cursor/`) from templates without
re-cloning. Run this when templates are updated.

```bash
bun run dev -- update-config
```

### `verify`

Health check — confirms repos are cloned and Claude + Cursor config files exist.

```bash
bun run dev -- verify
```

### `scaffold-secrets` / `verify-secrets`

Scaffold and check `~/.config/<workspace>/` agent automation files (GitHub App
activate scripts, Slack env layout, optional Cursor `sessionStart` hook).
Does **not** write secret values — see
[`team-setup/docs/workspace-agent-secrets.md`](./team-setup/docs/workspace-agent-secrets.md).

```bash
bun run dev -- scaffold-secrets --workspace comita --register-cursor-hook
bun run dev -- verify-secrets --workspace comita
bun run dev -- verify-secrets --workspace comita --online
```

### `tracks`

List available track configurations.

```bash
bun run dev -- tracks
```

### `shell-alias`

Print the `gotor` shell alias.

```bash
bun run dev -- shell-alias
```

## Directory Structure After Setup

```
~/projects/comita/   (or ~/projects/rosetta/ for a stock Rosetta workspace)
├── CLAUDE.md                    (shared agent brief — Claude Code + Cursor)
├── AGENTS.md                    (Cursor-oriented map; points at CLAUDE.md)
├── .claude/                     (Claude settings, commands, rules, skills)
├── .cursor/                     (Cursor cli.json, skills/, mirrored rules)
├── all.code-workspace           (generated — open in VS Code or Cursor)
├── rosetta_dev-scripts/         (this repo)
├── rosetta_docs/                (cloned — PRDs, ADRs, docs, shared assets)
├── rosetta_chronicle/           (cloned — memory engine)
├── rosetta_wayfinder/           (cloned — knowledge guide)
├── comita_docs/                 (Comita — company docs & brand; Comita workspaces)
├── comita_admissions/           (Comita — admissions product; Comita workspaces)
├── comita_website/              (Comita — marketing site; Comita workspaces)
└── rosetta_chronicle_<you>/     (created + cloned — your private personal Chronicle)
```

All workspace repos — engine `rosetta_*` packages plus any consumer product repos listed
in `team-setup/src/config/shared.json` `flatRepos` — are cloned side by side at the
workspace root. Cross-cutting artifacts (PRDs, ADRs, vision, shared assets) live
in the versioned **`rosetta_docs`** repo (and consumer `*_docs` where present).
`tracks/default.json` no longer defines any doc `projects`.

### Personal Chronicle

Setup also provisions a **private, per-person Chronicle repository** under the **user's own GitHub
account**, named from the login of the currently authenticated `gh` user (e.g.
`example-user/rosetta_chronicle_example-user`). It is created **private**, so only the owner can
see it, reflecting the platform value _"private by default, shared by intention"_ (see
`rosetta_docs/docs/FOUNDATIONS.md` and `rosetta_docs/architecture/ADR-0002`).

The personal chronicle belongs to the person, not the org: your memory must survive leaving any
organization (ADR-0005's exit test). This also makes onboarding non-engineers simple — create or
sign into a free GitHub account (free accounts include unlimited private repos), run
`gh auth login`, then run setup.

**Legacy:** chronicles provisioned by earlier versions live under the org
(`<org>/rosetta_chronicle_<you>`). Setup still finds and clones them, and prints the
`gh api …/transfer` command to move ownership to your account when you're ready.

Full `setup` (not `--skip-clone`) also:

- Writes `~/.config/rosetta/chronicle.env` (`CHRONICLE_REPO` / `CHRONICLE_PROJECT`)
- Registers the Claude Code Stop hook in `~/.claude/settings.json`
- Registers Cursor `sessionStart` + `stop` hooks in `~/.cursor/hooks.json`

Session append is fully supported for both Claude Code and Cursor Agent/CLI: Chronicle reads Cursor
transcripts from `~/.cursor/projects/` and session metadata from `~/.cursor/chats/`, so live capture
and `chronicle backfill` cover both tools. A marker-based catch-up sweep also runs in the background
on Cursor session start (at most once a day), healing recent days — late session titles, sessions
that ended without a stop event — and covering any gap since the last successful sweep, so even a
weeks-long absence backfills automatically on your first session back.

## Adding a New Repo

1. Add an entry to `flatRepos` in `team-setup/src/config/shared.json` (or use `/add-repo <url>` / the Cursor `command-add-repo` rule)
2. Run `bun run dev -- update-config` to regenerate config
3. Run `bun run dev -- setup --skip-install` to clone it
4. Commit and push so teammates get it on their next pull

### Mixing orgs (per-repo `org` override)

`shared.json` has a workspace-level `org`, but each entry in `flatRepos` /
`sharedRepos` (and track `repos`) may set an optional `"org"` field. The cloner
resolves `repo.org ?? shared.org`, so a forked adopter workspace can clone
Rosetta-Foundation engine repos and its own app repos side by side without
forking the engine:

```json
{
  "org": "Acme-Corp",
  "flatRepos": [
    {
      "name": "rosetta_chronicle",
      "ghRepo": "rosetta_chronicle",
      "org": "Rosetta-Foundation",
      "label": "Chronicle — Memory Engine"
    },
    {
      "name": "acme_app",
      "ghRepo": "acme_app",
      "label": "Acme App"
    }
  ]
}
```

## Implementation Specs

`specs/` holds implementation specs (one folder per PRD, one file per rollout
phase) for capabilities whose implementation lands in this repo — format and
lifecycle per
[ADR-0008](https://github.com/Rosetta-Foundation/rosetta_docs/blob/main/architecture/ADR-0008-implementation-spec-format.md).
A spec's `status: Draft → Approved` flip is the human gate before
implementation begins.

## Keeping This README Current

When making changes to the tool, update this README in the same commit:

| Change                        | What to update               |
| ----------------------------- | ---------------------------- |
| New repo added to `flatRepos` | Directory Structure          |
| New CLI command or flag       | Commands section             |
| New feature or behavior       | What You Get section         |
| Workspace layout changes      | Directory Structure          |
| Agent-tool support changes    | Prerequisites + What You Get |

The directory structure in this file must mirror the `flatRepos` in
`team-setup/src/config/shared.json`.

## License

[Apache-2.0](LICENSE) — Copyright 2026 Rosetta Foundation.
