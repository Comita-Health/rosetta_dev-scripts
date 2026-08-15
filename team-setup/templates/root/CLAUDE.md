# Rosetta — Engineering Workspace

This is a **Rosetta** engineering workspace. Chronicle is the memory; Wayfinder
is the guide. Engine repos (`rosetta_*`) live under
[Rosetta-Foundation](https://github.com/Rosetta-Foundation). Consumer product
repos, when present, live in the consumer's own GitHub org and are listed only
in that consumer's workspace config — never hardcoded upstream.

Agent tooling is dual-compatible: **Claude Code** and **Cursor Agent / CLI**.
See `AGENTS.md` for the Cursor-oriented map; this file is the shared brief both
tools load.

## Domain guardrails

Consumers own domain policy (what must never enter git, what surfaces are
forbidden, what "verified" means). Declare it in the consumer's docs and in
`.sdlc/` contracts — not by patching Rosetta engine defaults. See
[ADR-0009](https://github.com/Rosetta-Foundation/rosetta_docs/blob/main/architecture/ADR-0009-platform-boundary-mechanism-vs-policy.md).

## Foundations — Read First

`rosetta_docs/foundations/` is the project's constitution — founding context,
manifesto, principles, glossary, and settled decisions. Read it before making
architectural or product decisions. When implementation and philosophy
conflict, philosophy wins.

## SDLC drops (default for inbox work)

When the ask is a GitHub issue (or a small set) that should land as **one PR**:

- Follow **`sdlc-drop`** — `sdlc-workflow drop` arms one worktree, implement
  as commits, `drop --finish` opens the PR, then `pr-approve-watch`.
- Slash reminder: `/sdlc-drop`.
- Do **not** `decompose` a drop into per-task PRs.

`--finish` does **not** wait on reviewer, CI, or AC. For `direct` it then
calls `gh pr merge`. That succeeds when protection does not require a
person — Foundation `main` today requires status checks (`test`, DCO) only,
not approving reviews. Pass **`--require-approve`** when human Approve /
GHA merge-on-approve must stay the proceed signal. `BRANCH_PROTECTION_REQUIRES_HUMAN`
only fires when protection actually requires a review.

## SDLC runs (spec-task opt-in)

When kicking off or watching `sdlc-workflow` (`run` / shadow waves) for an
Accepted multi-task spec:

- Follow **`sdlc-run-supervise`** — engine `--supervise --detach`, `--heartbeat`,
  yield the agent turn, check in on wakes. Do **not** block the chat on
  sandbox/CI waits.
- Slash reminder: `/sdlc-run`. Scorecards: `/sdlc-status`.
- Design note: `rosetta_dev-scripts/sdlc-workflow/docs/operator-background-supervise.md`.

## PR Approve watch (proceed signal)

When you open a PR that needs a human proceed (especially Addi / bot-authored
PRs): follow **`pr-approve-watch`** — arm the background Approve watcher, wake
on `AGENT_LOOP_WAKE_pr_approve`, triage review comments. If the repo enables
**Addi merge on Approve** (GHA), do **not** merge from the agent — pull the
default branch after GHA merges. Otherwise merge as Addi, then pull. Do **not**
treat chat "approved" as the proceed signal. Slash: `/watch-pr-approve`. See
`rosetta_dev-scripts/team-setup/docs/addi-pr-automation-standard.md`.

## Package Manager

Always use `bun` over `npm`/`yarn` (`bun install`, `bun run <script>`).

## Environment Setup

- Node v20+ (check `.nvmrc` in each repo) — still the runtime for CLIs, jest, and Vite
- Bun 1.3+ (package manager — `curl -fsSL https://bun.sh/install | bash`)
- GitHub CLI (`gh`) authenticated
- At least one AI agent CLI:
  - Claude Code (`claude`), and/or
  - Cursor Agent CLI (`agent` — `curl https://cursor.com/install -fsS | bash` then `agent login`)

## Folder Structure

```
rosetta/
├── rosetta_dev-scripts/     Workspace tooling (team-setup + sdlc-workflow)
├── rosetta_docs/            PRDs, ADRs, foundations
├── rosetta_chronicle/       Memory engine
├── rosetta_wayfinder/       Knowledge guide
└── rosetta_chronicle_<you>/ Personal chronicle (in your GitHub account)
```

Consumer workspaces add their own product repos beside these. Each repo has a
`CLAUDE.md` describing its purpose and structure.

## Architecture — Handler / Service / Repository (MANDATORY)

All TypeScript code in every Rosetta repo MUST follow the
Handler / Service / Repository pattern with InversifyJS dependency injection. This is a project
standard, enforced the same way as Conventional Commits and the PR review cycles below.

The full ruleset lives in `.claude/rules/architecture-hsr.md` (Claude Code) and is mirrored to
`.cursor/rules/architecture-hsr.mdc` (Cursor) by team-setup. In brief:

- Strict one-way dependency: **Handler → Service → Repository**.
- Every class is `@injectable()`; dependencies are constructor-injected via `@inject(TOKEN)`.
- Tokens are `Symbol.for(...)` values collected in a `*_TOKENS` const; the token — not the
  interface — is the runtime injection key.
- Each class file co-locates its `interface IFoo` and `@injectable() class Foo implements IFoo`.

Read the architecture rule before writing or reviewing any TypeScript.

## Git Workflow

### Starting work

**Inbox / direct issues use a drop** (`sdlc/drop/<id>` via `sdlc-workflow drop`)
— see **SDLC drops** above. Hand-cut `f/` / `b/` branches stay valid for
work that is not going through the drop CLI.

**Always sync the default branch before creating a feature branch.** The first step of any
new task — before writing code or even analyzing — is to get onto an up-to-date `main`. Never
branch from a stale or arbitrary current branch.

```bash
git checkout main
git pull --ff-only
git checkout -b f/TICKET-123-short-description
```

Branch prefixes: `f/` for features, `b/` for bugs. Drop branches are
`sdlc/drop/<id>`.

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

### Commit messages — Conventional Commits

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

`chronicle` is reserved for **machine-authored ledger commits** — commits written
by Chronicle machinery into ledger repos, e.g. `chronicle(daily): 2026-07-31`
(ADR-0007 in rosetta_docs). Humans never hand-write it; code changes to the
Chronicle product use normal types.

Breaking changes append `!` after the type/scope: `feat(PROJ-123)!: drop Node 18 support`.

**Sign-off is mandatory (DCO).** Every commit certifies the
[Developer Certificate of Origin](https://developercertificate.org) — always commit with
`git commit -s` so the `Signed-off-by:` trailer is present. PRs fail the DCO check without it.
See each repo's `CONTRIBUTING.md`. There is no CLA.

### Finishing work

When work is complete, push the branch and open a PR **as Addi** (never as the
human `gh` user — humans must Approve agent PRs):

```bash
eval "$(bash ~/.config/rosetta/github-app-activate.sh)"
gh api graphql -f query='query { viewer { login } }' --jq '.data.viewer.login'  # must be *addi*[bot]
git push -u origin HEAD
gh pr create --title "…" --body "$(cat <<'EOF'
…
EOF
)"
```

Consumer workspaces use their own activate script under `~/.config/<workspace>/`
instead. See `.claude/rules/addi-authorship.md`. Same rule for `gh issue create`.

**No tool marketing in PR bodies or commits.** Never include `Made with Cursor`,
`Made-with: Cursor`, or similar AI-tool footers/trailers. Prefer `--body` /
`--body-file` HEREDOCs. If Cursor still injects a footer after create (known
bug even with attribution off), strip it with `gh pr edit` before the PR is
ready. Operators: turn off Cursor Settings → Attribution (commits + PRs) and
keep `attribution.attributePRsToAgent: false` in `~/.cursor/cli-config.json`
only (project `.cursor/cli.json` may contain `permissions` only — see rule
`no-tool-attribution`).

**Immediately after pushing, return to an up-to-date default branch** — do not linger on the
feature branch:

```bash
git checkout main
git pull --ff-only
```

This keeps the local default branch current and leaves the working tree clean between tasks.
Auto-branch-deletion on merge is enabled org-side, so the remote feature branch is removed
automatically once the PR merges; delete the local branch when you next sync.

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
