# Spike notes: Addi merge-on-approve via GitHub Actions

**Status:** historical spike notes — **canonical spec is**
[`addi-pr-automation-standard.md`](./addi-pr-automation-standard.md).

**Decision (still valid):** Cursor Automations **cannot** keep the Addi M.
identity for GitHub writes. Official identity is `cursor` (comments/reviews/team
PRs) or the creating user’s personal OAuth (private automations). There is no
supported “run as GitHub App X” switch. Therefore the unattended Approve →
merge path that preserves Addi (`rosetta-s-addi-m[bot]` / Comita
`addi-m[bot]`) is GHA + installation token, not Cursor Automations.

Local `pr-approve-watch` is demoted to Request-changes + comment triage when
GHA merge-on-approve is enabled (see gold standard).

## Goals

1. On human `APPROVED` review of an Addi-authored PR, merge **as Addi**.
2. Wait for required checks to go green before merge.
3. If `mergeable=CONFLICTING`, comment as Addi (do not force-merge); leave
   conflict resolution to an agent/human.
4. Opt-in via repo variable so the workflow can land disabled.

## Non-goals (this spike)

- Full review-comment triage / Copilot thread resolution (still agent work).
- Multi-repo org rollout (copy/reusable workflow later).
- Cursor Automations webhook fan-out (unnecessary if GHA merges directly).

## Secrets / vars (repo or org)

| Name                    | Kind     | Purpose                                                             |
| ----------------------- | -------- | ------------------------------------------------------------------- |
| `ADDI_CLIENT_ID`        | variable | GitHub App **Client ID** (e.g. `Iv23…`) — `client-id` input         |
| `ADDI_APP_PRIVATE_KEY`  | secret   | PEM private key for App `addi-m`                                    |
| `ADDI_MERGE_ON_APPROVE` | variable | Set to `true` to enable the job                                     |
| `ADDI_APP_ID`           | variable | Legacy numeric App ID — unused by the workflow after client-id move |

App needs installation permissions on the repo: **contents** (write),
**pull requests** (write), **checks** (read), **workflows** (if merging
workflow file changes — usually already covered by contents).

## Workflow

`.github/workflows/addi-merge-on-approve.yml`

- Triggers:
  - `pull_request_review` (`submitted`) — preferred, when GitHub delivers it
  - `schedule` every 5 minutes — **reliability path** (see troubleshooting)
  - `workflow_dispatch` with `pr_number` — manual / proof runs
- Filters: review state `approved` (event) or `reviewDecision==APPROVED`
  (poll); head repo is not a fork; PR author login is Addi
  (`app/rosetta-s-addi-m` from `gh`, or `rosetta-s-addi-m[bot]`), unless
  `ADDI_MERGE_ANY_AUTHOR=true`.
- Auth: `actions/create-github-app-token@v3` → `GH_TOKEN`.
- Gate: `reviewDecision==APPROVED`, checks green (`gh pr checks --watch`),
  `mergeable==MERGEABLE`.
- Action: `gh pr merge --squash --delete-branch` (matches recent
  `rosetta_dev-scripts` practice). Stacked PRs that require merge commits
  should stay on the local watch path or set merge method later.
- Conflict comments are idempotent (marker `## Addi merge-on-approve`).

### Troubleshooting: workflow never runs on Approve

**A — Invalid YAML (startup failure)**

If Actions shows the workflow **name as the file path**, `workflow_dispatch`
returns HTTP 422 (“does not have workflow_dispatch trigger”), and every push
creates a **startup-failure** run with **zero jobs**, the YAML failed to
parse. A common cause is a bash heredoc body at column 0 inside `run: |` —
that terminates the YAML block scalar early. Keep multiline comment text in
an `env:` literal (as the workflow does for `CONFLICT_BODY`), or indent every
heredoc line to the block’s content indent.

**C — Job hangs on "Waiting for checks"**

`pull_request_review` registers this workflow as a pending PR check named
`merge`. Using `gh pr checks --watch` waits for that check — a self-deadlock.
The workflow polls `statusCheckRollup` and **excludes** workflow name
`Addi merge on Approve` / the current `GITHUB_RUN_ID`.

**B — `pull_request_review` delivers no runs**

Observed on `rosetta_dev-scripts` (2026-08-02): human Approve on Addi PRs
#66/#67 created **zero** `pull_request_review` workflow runs, even after the
YAML parse fix and dismiss/re-approve via API. `workflow_dispatch` worked.
Until that is explained (GitHub delivery vs repo/org filter), the **5-minute
`schedule` poll** is the automatic path: it lists open APPROVED Addi PRs and
merges or posts the conflict comment. Prefer fixing event delivery later
(App webhook → `workflow_dispatch`, or GitHub support) over shortening the
cron further.

## Operator checklist

1. Add `ADDI_CLIENT_ID` + `ADDI_APP_PRIVATE_KEY` to the repo (or org) vars/secrets.
2. Confirm App installation includes this repository.
3. Set `ADDI_MERGE_ON_APPROVE=true`.
4. Open an Addi PR, Approve as a human, confirm merge author is
   `rosetta-s-addi-m[bot]`.
5. Open a conflicting Addi PR, Approve, confirm Addi comments instead of
   merging.

## Follow-ups

- Extract reusable workflow under `.github/workflows/reusable-*.yml` and
  enable in `rosetta_docs` / Comita repos.
- Optional second job: on `CONFLICTING`, open a tracking comment that pings
  Slack or files a short issue.
- Keep IDE `pr-approve-watch` for comment triage until that logic is ported
  into an Addi-authenticated agent job (harder; not this spike).
