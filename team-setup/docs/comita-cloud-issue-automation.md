# Comita Cloud — GitHub issue-comment automation

**Environment:** [Comita](https://cursor.com/dashboard/cloud-agents/environments/e/fc5673aa-934d-11f1-ba66-0e7d0216e441)  
**Create at:** [cursor.com/automations](https://cursor.com/automations)

## Dashboard settings

| Field        | Value                                                                             |
| ------------ | --------------------------------------------------------------------------------- |
| Name         | `Comita — issue comment remediation`                                              |
| Trigger      | GitHub → **Issue comment**                                                        |
| Repositories | Multi-repo environment **Comita** (all Comita-Health repos)                       |
| Tools        | Comment on issue/PR (if available), Send to Slack (optional), PR creation enabled |
| Permissions  | **Private** (your usage) until team-owned Addi auth is sorted                     |
| Model        | Team default / strong reasoning model                                             |

### Trigger filters (recommended)

- Fire on **human** comments only (Cursor ignores bot/App comments by design).
- Keyword / regex filter (if the UI supports it), e.g. match any of:
  - `(?i)@(cursor|addi)\b`
  - `(?i)\b(handle this|please (fix|resolve|remediate)|auto[- ]?remediat)`
- Without a filter, every human issue comment starts a billable agent — prefer a filter.

## Prompt (paste into the automation)

```text
You are Addi operating in the Comita multi-repo Cursor Cloud environment.

Identity (mandatory)
- Before any git push, gh pr/issue write, or GitHub API write:
  eval "$(bash ~/.config/comita/github-app-activate.sh)"
- Verify: gh api graphql -f query='query { viewer { login } }' --jq '.data.viewer.login'
  must be addi-m[bot]. If not, stop and comment the failure on the issue.
- Never open PRs or push as the ambient Cursor/human gh identity when Addi is available.
- DCO: git commit -s. Conventional Commits. No "Made with Cursor" footers.

Input
- Read the GitHub issue that triggered this run (title, body, latest human comments).
- Follow linked Blocker PR / branch / head / spec references in the body.
- Prefer the Comita AGENTS.md + rosetta_dev-scripts conventions.

Decide whether this is auto-remediable
Safe to handle without a new human product decision:
1) mergeable=CONFLICTING on an already-Approved Addi PR (merge origin/<base> into tip, resolve, push)
2) green CI after a small fix already specified in the issue
3) docs / link backfills explicitly called out (e.g. CURSOR_DATA_DIR docs already drafted)
4) re-dispatch / comment-only unblocks when code is already correct

Do NOT auto-merge when the repo uses Addi merge-on-approve — push the fixed tip and let GHA merge after human Approve (or workflow_dispatch). Never force-merge CONFLICTING tips.

Unsafe / stop and comment instead:
- Ambiguous product changes, PHI risk, broad refactors, secrets rotation, deleting data
- Request-changes reviews that need human judgment
- Anything that would skip required human Approve

Execution
1) Comment on the issue that you started (brief plan).
2) Perform the smallest safe remediation on the correct branch/repo.
3) Push as Addi; wait for CI if you pushed.
4) Comment the result: PR URL, head SHA, what changed, what the human should do next (Approve / smoke / close issue).
5) Optionally notify Slack using `SLACK_BOT_TOKEN` + `SLACK_CHANNEL_ID` with a
   one-line status (never print secret values). On a local desktop, those vars
   come from `~/.config/comita/slack.env` (scaffold + shared-vault walkthrough:
   [`workspace-agent-secrets.md`](./workspace-agent-secrets.md)); in Cursor
   Cloud they are environment secrets.

If nothing actionable: reply on the issue explaining why and what you need from the human.
```

## Smoke test

1. On a disposable sample issue (or `#69` if still open), comment as yourself:  
   `@cursor please handle conflict remediation on the blocker PR`
2. Confirm a Cloud Agent starts in environment **Comita**.
3. Confirm the agent’s GitHub writes show as **addi-m[bot]** (not your login / `cursor`).
4. Confirm the issue gets a progress + completion comment.

## Notes

- Cursor Automations’ built-in “Comment on PR” tool may post as `cursor`; prefer `gh` after Addi activate for operator-facing comments when authorship matters.
- Bot comments (including Addi’s merge-on-approve CONFLICTING note) do **not** trigger this automation — a human must ask.
- After #70, Builds run `.cursor/install-comita-cloud.sh`, which materializes `~/.config/comita` from environment-scoped secrets.
- **Secrets are often absent during environment Builds** (install logs: `Addi secrets not present yet`). Runtime agent injects them; re-run `bash .cursor/install-comita-cloud.sh` (or rely on async install) so `~/.config/comita/github-app-activate.sh` exists before any `gh` write.

## Troubleshooting Addi activate

| Symptom                                                    | Likely cause                                                             | Fix                                                                                                                                                         |
| ---------------------------------------------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `~/.config/comita/github-app-activate.sh: No such file`    | Install skipped (stale build) or secrets missing at materialize time     | `bash .cursor/install-comita-cloud.sh` with env secrets injected                                                                                            |
| Token mint / cryptography “Could not deserialize key data” | Truncated PEM, or dashboard paste collapsed newlines into **spaces**     | Paste the **full** addi-m App private key (BEGIN…END). Install normalizes quotes, literal `\n`, and space-collapsed single-line PEMs (re-chunks to 64-col). |
| `gh` viewer is `cursor[bot]` / issue comment 403           | Addi activate never succeeded; ambient Cursor token lacks `issues:write` | Fix the PEM secret, rematerialize, then `eval "$(bash ~/.config/comita/github-app-activate.sh)"` and confirm `addi-m[bot]`                                  |
| Install ERROR: “not a complete PEM (bytes=…)”              | Secret is a header/placeholder (~tens of bytes)                          | Replace secret with full PEM; expect typically >200 bytes after normalize                                                                                   |

Quick shape check (does not print the key):

```bash
python3 - <<'PY'
import os
v = os.environ.get("GITHUB_APP_PRIVATE_KEY", "")
print(
    "len", len(v),
    "has_BEGIN", "BEGIN" in v,
    "has_END", "END" in v,
    "newlines", v.count("\n"),
    "spaces", v.count(" "),
)
PY
```
