# rosetta_dev-scripts — agent brief

Read [`CLAUDE.md`](./CLAUDE.md) for package layout, git conventions, and
architecture. This file adds Cursor Cloud–specific notes for the **Comita**
multi-repo environment.

## Cursor Cloud specific instructions

Environment name: **Comita** (dashboard multi-repo). Install is
`.cursor/install-comita-cloud.sh` via `.cursor/environment.json`.

### Identity — always Addi

Agent-authored commits, branches, PRs, and issue writes use the Comita
**Addi** GitHub App — never ambient human `gh` and never Cursor’s default
`cursor` GitHub identity when filing Comita work.

```bash
eval "$(bash ~/.config/comita/github-app-activate.sh)"
gh api graphql -f query='query { viewer { login } }' --jq '.data.viewer.login'
# expect: addi-m[bot]
```

Install materializes `~/.config/comita/` from environment-scoped secrets:
`GITHUB_APP_ID`, `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_INSTALLATION_ID`,
`GITHUB_APP_SLUG`, `GITHUB_APP_PRIVATE_KEY`, and `GIT_AUTHOR_*` /
`GIT_COMMITTER_*`.

### Slack + laptop secrets onboarding

Credentials (never log values):

| Source               | Vars                                                          |
| -------------------- | ------------------------------------------------------------- |
| Cursor Cloud secrets | `SLACK_BOT_TOKEN`, `SLACK_CHANNEL_ID`, `SLACK_SIGNING_SECRET` |
| Local desktop        | `~/.config/comita/slack.env` (`chmod 600`)                    |

Local wiring:

- Shell: `~/.zshrc` sources `slack.env`; or
  `eval "$(bash ~/.config/comita/slack-activate.sh)"`.
- Cursor Agent: `sessionStart` hook
  `~/.cursor/hooks/comita-slack-session-start.sh` (or
  `<workspace>-slack-session-start.sh` from scaffold) injects the same vars
  into new agent sessions (registered in `~/.cursor/hooks.json`).

**New laptop / teammate setup** (shared Slack vs private GitHub App, optional
personal bot name, 1Password materialize): see
[`team-setup/docs/workspace-agent-secrets.md`](./team-setup/docs/workspace-agent-secrets.md).

```bash
cd team-setup
bun run dev -- scaffold-secrets --workspace comita --register-cursor-hook
bun run dev -- verify-secrets --workspace comita
```

Use Slack credentials for reading threads / operator notify mirrors when asked.

### Remediations from GitHub issues

When kicked from an issue comment / automation:

1. Read the issue + linked Blocker PR.
2. Prefer safe auto-remediation: tip conflicts with `main`, green CI after
   push, docs/link backfills already specified in the issue.
3. Activate Addi before push / `gh pr create` / comments.
4. **Do not** merge when `ADDI_MERGE_ON_APPROVE` applies — resolve conflicts,
   push, then let the human Approve (or re-dispatch merge-on-approve).
5. Comment progress on the issue; if blocked, say what needs a human.

### Sibling repos

The Comita cloud environment also includes `comita_admissions`,
`comita_docs`, `comita_website`, and `rosetta_chronicle_comita-health`.
Coordinate cross-repo changes when the task requires them; open PRs as Addi
in each affected repo.
