# Workspace agent secrets — laptop / teammate onboarding

**Status:** canonical for Rosetta + consumer workspaces (Comita, etc.)  
**Audience:** new engineers, laptop rebuilds, admins who share operator credentials

This guide covers how to put **agent automation credentials** on a machine
under `~/.config/<workspace>/` without committing secrets, and how the team
safely shares **community** values while each engineer keeps **private** ones.

Related:

- [Addi PR automation standard](./addi-pr-automation-standard.md) — org Addi +
  merge-on-approve (Actions secrets, not laptop `.env` files)
- [Comita Cloud issue automation](./comita-cloud-issue-automation.md) — Cloud
  VM materialize from environment-scoped secrets

## Mental model: two classes of secret

| Class                  | Examples                                                                                                | Who has the same value?    | Where it lives                                                        |
| ---------------------- | ------------------------------------------------------------------------------------------------------- | -------------------------- | --------------------------------------------------------------------- |
| **Shared / community** | Slack bot token, channel id, signing secret; _optional_ org Addi App used by every local agent          | Every engineer on the team | Shared password-manager vault (preferred) or Cursor Cloud env secrets |
| **Private**            | Personal GitHub App PEM + ids when you name your own bot; personal API tokens; Chronicle personal paths | Only you                   | Private vault / your machine only                                     |

Rules of thumb:

1. **Never** put secret values in git, PR bodies, issues, Slack DMs, or email.
2. **Never** commit resolved `*.env` / `*.pem` files.
3. Prefer **1Password secret references** (`op://…`) + `op inject` /
   [`op run`](https://developer.1password.com/docs/cli/secrets-environment-variables/)
   so templates can live in git while values stay in the vault
   ([config-file inject docs](https://developer.1password.com/docs/cli/secrets-config-files/)).
4. Local materialized files are always `chmod 600` (directory `700`).
5. PHI / clinical data is **never** part of this layout (healthcare guardrails).

### Naming your bot (Addi vs personal)

You **may** create a personal GitHub App with any slug (not only `addi-m`).
Agent authorship only requires: activate script → installation token → PRs
authored as that bot so a **human** can Approve.

Trade-offs:

| Choice                                              | Pros                                                     | Cons                                                                                                                                              |
| --------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Org shared Addi** (`addi-m` / `rosetta-s-addi-m`) | Matches merge-on-approve allow-lists; familiar in review | Shared App credential must be vault-protected                                                                                                     |
| **Personal bot** (`your-name-agent`, etc.)          | Full control; rotate without affecting teammates         | `addi-merge-on-approve` may **not** auto-merge your PRs unless the workflow allow-list / `ADDI_MERGE_ANY_AUTHOR` is updated; humans still Approve |

Org **Actions** vars `ADDI_CLIENT_ID` / `ADDI_APP_PRIVATE_KEY` stay on the
**org Addi** app used by GHA — that is separate from whichever App you activate
locally for day-to-day agent commits.

## Layout after scaffold

```text
~/.config/<workspace>/
  github-app-activate.sh    # eval to export GH_TOKEN + GIT_* as the bot
  github-app-token.sh       # mints installation token (needs python3+cryptography)
  github-app.env            # private — App ids + slug + author emails
  github-app.pem            # private — App private key
  slack-activate.sh
  slack.env                 # shared — Slack bot credentials
  op/
    slack.env.tpl           # 1Password references (safe to customize locally)
    github-app.env.tpl
~/.cursor/hooks/
  <workspace>-slack-session-start.sh   # sessionStart JSON env injector
```

`<workspace>` is typically `comita` or `rosetta`.

## One-time admin setup (shared secrets)

An org admin (or founding engineer) should:

1. Create a **shared** vault (or 1Password Environment) for Engineering — e.g.
   `Comita Engineering` — with group access for the eng team only.
2. Create item **Agent Slack Bot** with fields:
   - `bot_token` (`xoxb-…`)
   - `channel_id`
   - `signing_secret`
3. _(Optional)_ If every laptop should use the **same** org Addi App, store
   that App’s ids + PEM in the shared vault under a clear item name
   (`Agent GitHub App (addi-m)`). Prefer a **dedicated** shared item, not a
   dump of unrelated prod credentials.
4. Grant new hires vault access via the password-manager group — **not** by
   pasting tokens into chat.
5. Point teammates at this doc + the scaffold command below.

Cursor Cloud: keep using environment-scoped secrets (`SLACK_*`,
`GITHUB_APP_*`) consumed by `install-comita-cloud.sh` — same _values_ as the
shared vault, different _delivery_ path.

## Engineer laptop walkthrough

### 0. Prerequisites

- Workspace bootstrapped (`team-setup` / `bootstrap.sh`)
- `gh` authenticated as **you** (human) for normal browsing
- `python3` + `cryptography` (`pip install cryptography` or brew equivalent)
  for GitHub App token minting
- Optional but recommended: [1Password CLI](https://developer.1password.com/docs/cli/get-started/)
  (`brew install 1password-cli`) signed in with vault access

### 1. Scaffold (no secrets yet)

From `rosetta_dev-scripts/team-setup/`:

```bash
bun run dev -- scaffold-secrets --workspace comita --register-cursor-hook
# or:
bash scripts/scaffold-workspace-secrets.sh --workspace comita --register-cursor-hook
```

This writes scripts + empty examples under `~/.config/comita/` and registers
the Cursor `sessionStart` Slack injector when `--register-cursor-hook` is set.

### 2. Materialize **shared** Slack

Preferred (1Password):

```bash
# Edit vault/item names in ~/.config/comita/op/slack.env.tpl if your org differs
bash scripts/materialize-workspace-secrets-from-1password.sh \
  --workspace comita --slack-only
```

Fallback: copy `slack.env.example` → `slack.env`, paste values from the vault
UI (still `chmod 600`). Do **not** invent a second Slack bot for day-to-day
operator mirrors unless the team explicitly decides that.

Wire your shell (once):

```bash
# ~/.zshrc
if [[ -f "$HOME/.config/comita/slack.env" ]]; then
  set -a
  source "$HOME/.config/comita/slack.env"
  set +a
fi
```

Or on demand: `eval "$(bash ~/.config/comita/slack-activate.sh)"`.

**Sandbox verify list id** (`COMITA_VERIFY_SLACK_LIST_ID`) is not a
secret. After the **Sandbox verify** Slack list exists, add the `F…` id
to `slack.env` (see `slack.env.example`). Bret checks Verified/Failed
there; do not reuse the Feedback tracker list id.

**New Cursor chats** pick up Slack via the `sessionStart` hook (existing chats
need a new session or a manual `eval`).

### 3. Set up **private** (or shared) GitHub App identity

**Option A — org Addi (team default for Comita):** pull the shared App item
from 1Password into `github-app.env` + `github-app.pem` (see
`materialize-workspace-secrets-from-1password.sh --github-only --pem-ref …`).

**Option B — personal bot:**

1. GitHub → Settings → Developer settings → **GitHub Apps** → New
   (or org Settings if the App is org-owned).
2. Permissions typically needed for agent PR work: Contents, Pull requests,
   Issues, Metadata (read); adjust to least privilege for your org.
3. Generate a private key → save as `~/.config/<workspace>/github-app.pem`
   (`chmod 600`).
4. Install the App on the org / repos you need; note **App ID**,
   **Installation ID**, **slug**, and Client ID.
5. Fill `github-app.env` (author/committer should be the bot’s noreply identity).

Activate + verify (never echo the token):

```bash
eval "$(bash ~/.config/comita/github-app-activate.sh)"
gh api graphql -f query='query { viewer { login } }' --jq '.data.viewer.login'
# expect: your-bot[bot]  — not your human login
```

### 4. Verify

```bash
bash scripts/verify-workspace-secrets.sh --workspace comita
bash scripts/verify-workspace-secrets.sh --workspace comita --online
```

`--online` calls Slack `auth.test` and the GitHub viewer query; it prints
lengths / ok flags only, not secret values.

## What agents should do

- Prefer `eval "$(bash ~/.config/<workspace>/github-app-activate.sh)"` before
  `gh pr create` / `gh issue create` / agent pushes (see `addi-authorship`).
- Prefer Slack env from `sessionStart` / `slack-activate.sh`; never log tokens.
- If activate is missing, point the human at this doc — do not invent secrets
  or fall back to ambient human `gh` for PR/issue creation.

## Anti-patterns

| Don’t                                                                     | Do instead                                                |
| ------------------------------------------------------------------------- | --------------------------------------------------------- |
| Paste `xoxb-` / PEM into Slack or a PR                                    | 1Password shared vault + `op inject`                      |
| Commit `slack.env` / `github-app.pem`                                     | Keep under `~/.config/`; gitignore locally if you symlink |
| `chmod 644` on env/pem                                                    | `chmod 600`                                               |
| Use human `gh` identity so you can “Approve your own PR”                  | Bot authorship + human Approve                            |
| Assume personal bots get merge-on-approve                                 | Update allow-list or use org Addi                         |
| Share one engineer’s **personal** App PEM in the shared vault by accident | Label items clearly; private vault for personal bots      |

## Script index

| Script                                                    | Purpose                                        |
| --------------------------------------------------------- | ---------------------------------------------- |
| `scripts/scaffold-workspace-secrets.sh`                   | Create layout + scripts + Cursor hook helper   |
| `scripts/materialize-workspace-secrets-from-1password.sh` | `op inject` / `op read` into `~/.config`       |
| `scripts/verify-workspace-secrets.sh`                     | Mode + key-presence (+ optional online) checks |
| `templates/workspace-secrets/**`                          | Checked-in templates (no real secrets)         |

CLI wrapper (from `team-setup/`):

```bash
bun run dev -- scaffold-secrets --workspace comita --register-cursor-hook
bun run dev -- verify-secrets --workspace comita
```
