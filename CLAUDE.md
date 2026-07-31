# rosetta_dev-scripts

Rosetta workspace tooling and scaffolding. The `team-setup` CLI bootstraps and maintains the Rosetta
multi-repo workspace and lays down standardized **Claude Code + Cursor Agent/CLI** configuration for
the whole team.

Before architectural or product decisions, read the project constitution in
`rosetta_docs/foundations/` (founding context, principles, glossary, settled decisions).

## Build & Test

```bash
# Install all workspace dependencies (from the repo root)
bun install

# All CLI/build/test commands run from team-setup/
cd team-setup

# Run the team-setup CLI in dev mode
bun run dev -- <command>

# Build
bun run build

# Test
bun run test
```

## team-setup CLI

```bash
bun run dev -- setup            # Bootstrap workspace
bun run dev -- verify           # Health check
bun run dev -- tracks           # List tracks
bun run dev -- shell-alias      # Print the gotor alias
bun run dev -- update-config    # Refresh Claude + Cursor config from templates
```

## Workspace Layout

Rosetta uses a **flat** workspace layout. Code repos live directly at the workspace root and are
configured under `flatRepos` in `team-setup/src/config/shared.json`. The default track's
`projects` list is empty — docs live in `rosetta_docs`.

## Adding a New Repo

1. Add the repo to `flatRepos` in `team-setup/src/config/shared.json` (see the `/add-repo` command).
2. Run `bun run dev -- update-config` to regenerate `all.code-workspace` and config.
3. Run `bun run dev -- setup --skip-install` to clone the new repo.
4. Update `README.md` and the folder diagram in `team-setup/templates/root/CLAUDE.md`.

## README Maintenance

When making any of the following changes, update `README.md` in the same commit:

- **New repo in `shared.json` `flatRepos`** → Directory Structure section
- **New CLI command or flag** → Commands section
- **New feature or behavior** → What You Get section
- **Workspace layout changes** → Directory Structure section

The directory structure in `README.md` must mirror `team-setup/src/config/shared.json` and
`tracks/default.json`.

## Git Workflow

### Starting work

Always start from an up-to-date default branch:

```bash
git checkout main
git pull
git checkout -b f/TICKET-123-short-description
```

Branch prefixes: `f/` for features, `b/` for bugs.

**Stacked branches — chain when overlapping.** Before branching, check whether the new work
modifies a file that one of your **open PRs** already modifies (canonical case: the ADR/PRD
records tables in `rosetta_docs`). If it does, branch from that PR's branch instead of `main`
and open the PR against it:

```bash
git checkout f/parent-branch
git checkout -b f/child-branch
# ...work, commit, push...
gh pr create --fill --base f/parent-branch
```

Merge stacks bottom-up (parent first). When the parent merges, GitHub automatically retargets
the child PR onto `main` — no conflict, no rebase. Stacked PRs require merge commits (never
squash-merge a stack). Unrelated work keeps branching from `main` so PRs stay independently
mergeable — do not chain by default.

**Default: do not commit on `main`.** All product work lands via a topic branch + PR.

### Direct commits to `main` (exceptions)

Topic branches are the default. Direct pushes to `main` are allowed only when a human
explicitly authorizes it for one of these cases:

1. **Foundation / bootstrap scaffolding** — standing up shared tooling across repos
   (e.g. husky, org-wide config, one-shot public repo initialization).
2. **Emergency hotfix** — a production-blocking fix where a human approves skipping the
   branch+PR cycle. Prefer a follow-up PR note when practical.

Even on an exception, **Conventional Commits still apply**. If authorization is unclear,
ask — do not assume.

### Commit messages — Conventional Commits (enforced by hook)

**Branch has a ticket** (e.g. `f/PROJ-123`): the ticket must be the scope.

```
feat(PROJ-123): add chronicle git source adapter
fix(PROJ-456): handle empty commit ranges correctly
```

**Branch has no ticket** (e.g. `f/my-cool-feature`): standard Conventional Commits.

```
feat: add chronicle git source adapter
fix(sources): handle empty commit ranges
```

Valid types: `feat` `fix` `chore` `docs` `style` `refactor` `perf` `test` `build` `ci` `revert` `chronicle`

`chronicle` is reserved for machine-authored ledger commits (ADR-0007 in
rosetta_docs), e.g. `chronicle(daily): 2026-07-31` — humans never hand-write it.

The `commit-msg` hook will reject messages that don't match. Breaking changes append `!` after the type/scope: `feat(PROJ-123)!: drop Node 18 support`.

### Finishing work

When work is complete, push the branch and open a PR:

```bash
git push -u origin HEAD
gh pr create --fill
```

### Copilot review cycle

After opening or pushing to a PR, GitHub Copilot posts an automated review (typically within 5 minutes). **You must process this before considering the PR ready.**

1. First check if Copilot is enabled on this repo: `gh api repos/{owner}/{repo}/pulls?state=closed&per_page=5` and check any of those PR's reviews for `copilot-pull-request-reviewer[bot]`. If none found, skip the entire cycle — Copilot is not enabled on this repo.
2. If enabled, poll `gh api repos/{owner}/{repo}/pulls/{number}/reviews` every 30 seconds for up to 10 minutes, stopping as soon as a `copilot-pull-request-reviewer[bot]` review appears.
3. Read the review body for the overview summary and check `gh api repos/{owner}/{repo}/pulls/{number}/comments` for inline thread comments. Copilot always posts a review body even when it has no inline comments — "generated no new comments" means nothing to address.
4. Evaluate each inline comment — address anything that is a genuine improvement (dead code, duplicate imports, misleading patterns, correctness issues). Dismiss comments that are stylistic noise or false positives.
5. Fix, commit, and push (use `fix(<scope>): address Copilot review comments` or a more specific message).
6. Reply to each addressed comment with the fix commit SHA and a brief explanation.
7. Resolve each addressed thread via the GraphQL `resolveReviewThread` mutation.
8. Run this cycle **once** — if Copilot posts new comments on the fix commit, flag them for human review rather than looping indefinitely.

### PR checks review cycle

After pushing to a PR, required status checks (CI) run automatically. **You must monitor and fix failing checks.** This cycle runs in parallel with the Copilot review cycle.

1. Poll `gh run list --branch {branch} --limit 5 --json status,conclusion,name,databaseId` every 30 seconds until all runs reach a terminal state (`completed`, `cancelled`, `failure`), up to 15 minutes.
2. If all checks pass, the cycle is done.
3. If any check fails:
   a. Retrieve logs: `gh run view {run-id} --log-failed`
   b. Diagnose the failure — read the error output and identify the root cause.
   c. Fix the issue locally, commit with an appropriate message (e.g. `fix(<scope>): correct type error caught by CI`), and push.
   d. Return to step 1 — poll the new run.
4. Repeat until all checks pass, up to **3 iterations**. If checks still fail after 3 fix attempts, flag for human review with a summary of what was tried and what remains broken.

### Cleaning up

After the PR is approved and merged, switch back to main and delete the local branch:

```bash
git checkout main
git branch -d f/TICKET-123-short-description
```

## Code Style

- TypeScript strict mode
- Prettier: single quotes, semicolons, 2-space indent
