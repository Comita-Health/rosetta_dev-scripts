# rosetta_dev-scripts

CLI to bootstrap and maintain the **Rosetta** workspace. Clones all repos, creates the directory
structure, and lays down Claude Code configuration that standardizes how the team works with
AI-assisted development.

Rosetta is an AI-native engineering knowledge platform — a shared memory layer for people, projects,
and AI. Chronicle is the memory; Wayfinder is the guide.

## Why Use Team Setup?

Team Setup gives every engineer a consistent, batteries-included Claude Code environment from day
one. Instead of each person configuring their own rules, permissions, and workflows, everyone gets
the same guardrails and automation.

### What You Get

**Enforced architecture** — The Handler / Service / Repository + InversifyJS pattern is mandated for
all TypeScript across every Rosetta repo (runtime and IaC), via `.claude/rules/architecture-hsr.md`.
Every teammate's agent reads and applies it automatically.

**Automated PR lifecycle** — Push, open a PR, and let Claude handle the rest:
- Automatic Copilot review processing: reads comments, fixes valid issues, replies with commit SHAs, resolves threads
- Automatic CI checks monitoring: detects failures, reads logs, diagnoses and fixes issues, re-pushes — loops up to 3 times before escalating to a human
- Both cycles run in parallel after every push

**Enforced commit conventions** — Conventional Commits format enforced via git hooks:
- Automatic ticket scope extraction from branch names (e.g. `f/PROJ-123-foo` produces `feat(PROJ-123): ...`)
- Consistent types: `feat`, `fix`, `chore`, `docs`, `refactor`, `perf`, `test`, `build`, `ci`, `revert`
- Breaking change notation with `!` suffix

**Safe-by-default permissions** — Pre-configured allow/deny lists so Claude can:
- Read, edit, and write files freely
- Run git, yarn, node, gh CLI commands without prompting
- Never force-push, `reset --hard`, or `rm -rf` critical paths

**Shared code style rules** — TypeScript strict mode, Prettier conventions, and import hygiene applied uniformly across all repos in the workspace.

**Slash commands out of the box:**
- `/review` — Review the current diff for correctness, security, and simplification
- `/add-repo` — Add new repos to the workspace with proper config scaffolding

**Multi-repo workspace** — One bootstrap gives you:
- All Rosetta repos cloned into a flat workspace
- VS Code multi-root workspace file generated automatically
- `gotor` fuzzy-navigation alias for quick repo switching
- Root and per-folder CLAUDE.md context so Claude understands the full landscape

### Adapting for Another Workspace

The setup is template-driven. To adopt this for a different workspace:

1. Fork this repo
2. Edit `team-setup/src/config/shared.json` (org, baseDir, `flatRepos`) and `tracks/default.json`
3. Replace `team-setup/templates/` content with your conventions
4. Update the `gotor` alias name/marker/path in `team-setup/src/index.ts` and `ORG`/`REPO`/`DEST` in `bootstrap.sh`
5. Your team runs the same one-line bootstrap

The CLAUDE.md files, rules, commands, and settings are all just files — version-controlled and updated via `update-config` when templates change.

---

## New Team Member Setup

### Prerequisites

- [GitHub CLI](https://cli.github.com/) — `brew install gh` then `gh auth login`
- [Node.js 20+](https://github.com/nvm-sh/nvm) — `nvm install 20`
- [Yarn](https://yarnpkg.com/) — `npm install -g yarn`
- [fzf](https://github.com/junegunn/fzf) (optional) — `brew install fzf` (for the `gotor` alias)

### One-line bootstrap

Run:

```bash
bash <(gh api repos/Rosetta-Foundation/rosetta_dev-scripts/contents/bootstrap.sh -q '.content' | base64 -d)
```

That's it. The script will:
1. Clone this repo into `~/projects/rosetta/rosetta_dev-scripts`
2. Install dependencies
3. Create the workspace directory structure
4. Lay down Claude Code config (CLAUDE.md, .claude/)
5. Generate `all.code-workspace` for VS Code
6. Print the `gotor` shell alias to add to your `~/.zshrc`

> The bootstrap runs setup with `--skip-clone`, so it scaffolds structure + config. Run
> `yarn workspace team-setup dev -- setup` afterward (without `--skip-clone`) to clone the
> Rosetta repos.

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

## Commands

Once bootstrapped, all commands run from inside `rosetta_dev-scripts/`:

### `setup`

Full workspace bootstrap (what `bootstrap.sh` calls internally).

```bash
yarn workspace team-setup dev -- setup

# Custom base directory
yarn workspace team-setup dev -- setup --base-dir ~/work/rosetta

# Skip cloning (structure + config only)
yarn workspace team-setup dev -- setup --skip-clone

# Skip yarn install
yarn workspace team-setup dev -- setup --skip-install
```

### `update-config`

Refresh CLAUDE.md files and `.claude/` directory from templates without re-cloning. Run this when templates are updated.

```bash
yarn workspace team-setup dev -- update-config
```

### `verify`

Health check — confirms repos are cloned and config files exist.

```bash
yarn workspace team-setup dev -- verify
```

### `tracks`

List available track configurations.

```bash
yarn workspace team-setup dev -- tracks
```

### `shell-alias`

Print the `gotor` shell alias.

```bash
yarn workspace team-setup dev -- shell-alias
```

## Directory Structure After Setup

```
~/projects/rosetta/
├── CLAUDE.md                    (from templates/root/)
├── .claude/                     (settings, commands, rules — incl. architecture-hsr.md)
├── all.code-workspace           (generated — all repos as VS Code multi-root)
├── rosetta_dev-scripts/         (this repo)
├── rosetta_docs/                (cloned — PRDs, ADRs, docs, shared assets)
├── rosetta_chronicle/           (cloned — memory engine)
├── rosetta_wayfinder/           (cloned — knowledge guide, placeholder)
└── rosetta_chronicle_<you>/     (created + cloned — your private personal Chronicle)
```

All workspace repos — `rosetta_dev-scripts`, `rosetta_docs`, `rosetta_chronicle`, and
`rosetta_wayfinder` — are configured as `flatRepos` in `team-setup/src/config/shared.json` and cloned
side by side at the workspace root. Cross-cutting artifacts (PRDs, ADRs, vision, shared assets) now
live in the versioned **`rosetta_docs`** repo rather than being scaffolded as untracked folders, so
they have history and are PR-reviewable. `tracks/default.json` no longer defines any doc `projects`.

### Personal Chronicle

Setup also provisions a **private, per-engineer Chronicle repository** under the org, named from the
login of the currently authenticated `gh` user (e.g. `rosetta_chronicle_example-user`). It is
created **private** — not the org's default `internal` visibility — so only the owner can see it,
reflecting the platform value *"private by default, shared by intention"* (see
`rosetta_docs/docs/FOUNDATIONS.md` and `rosetta_docs/architecture/ADR-0002`).

This is the only repo derived from the current user rather than a fixed list; each engineer only ever
creates or clones **their own**. If the repo already exists (e.g. on a repeat `setup`), provisioning
is skipped with a log line rather than failing. Configured under `personalChronicle` in
`team-setup/src/config/shared.json`.

## Adding a New Repo

1. Add an entry to `flatRepos` in `team-setup/src/config/shared.json` (or use `/add-repo <url>`)
2. Run `yarn workspace team-setup dev -- update-config` to regenerate config
3. Run `yarn workspace team-setup dev -- setup --skip-install` to clone it
4. Commit and push so teammates get it on their next pull

## Keeping This README Current

When making changes to the tool, update this README in the same commit:

| Change | What to update |
|--------|---------------|
| New repo added to `flatRepos` | Directory Structure |
| New CLI command or flag | Commands section |
| New feature or behavior | What You Get section |
| Workspace layout changes | Directory Structure |

The directory structure in this file must mirror the `flatRepos` in
`team-setup/src/config/shared.json`.
