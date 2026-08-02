# Spike: Addi merge-on-approve via GitHub Actions

**Status:** spike (opt-in, single-repo pilot in `rosetta_dev-scripts`)  
**Decision:** Cursor Automations **cannot** keep the Addi M. identity for
GitHub writes. Official identity is `cursor` (comments/reviews/team PRs) or
the creating user’s personal OAuth (private automations). There is no
supported “run as GitHub App X” switch. Therefore the unattended Approve →
merge path that preserves **Addi M. (`rosetta-s-addi-m[bot]`)** is GHA +
installation token, not Cursor Automations.

Local `pr-approve-watch` remains useful for IDE sessions; this spike replaces
the unreliable `notify_on_output` wake for merge execution.

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

| Name                    | Kind     | Purpose                                                 |
| ----------------------- | -------- | ------------------------------------------------------- |
| `ADDI_APP_ID`           | variable | Numeric GitHub App id (e.g. `4464370`) — `app-id` input |
| `ADDI_APP_PRIVATE_KEY`  | secret   | PEM private key for App `addi-m`                        |
| `ADDI_MERGE_ON_APPROVE` | variable | Set to `true` to enable the job                         |

App needs installation permissions on the repo: **contents** (write),
**pull requests** (write), **checks** (read), **workflows** (if merging
workflow file changes — usually already covered by contents).

## Workflow

`.github/workflows/addi-merge-on-approve.yml`

- Triggers: `pull_request_review` (`submitted`), plus `workflow_dispatch`
  for dry runs.
- Filters: review state `approved`; head repo is not a fork; PR author login
  is Addi (`app/rosetta-s-addi-m` from `gh`, or `rosetta-s-addi-m[bot]`),
  unless `ADDI_MERGE_ANY_AUTHOR=true`.
- Auth: `actions/create-github-app-token@v3` → `GH_TOKEN`.
- Gate: `reviewDecision==APPROVED`, checks green (`gh pr checks --watch`),
  `mergeable==MERGEABLE`.
- Action: `gh pr merge --squash --delete-branch` (matches recent
  `rosetta_dev-scripts` practice). Stacked PRs that require merge commits
  should stay on the local watch path or set merge method later.

### Troubleshooting: workflow never runs on Approve

If Actions shows the workflow **name as the file path**, `workflow_dispatch`
returns HTTP 422 (“does not have workflow_dispatch trigger”), and every push
creates a **startup-failure** run with **zero jobs**, the YAML failed to
parse. A common cause is a bash heredoc body at column 0 inside `run: |` —
that terminates the YAML block scalar early. Keep multiline comment text in
an `env:` literal (as the workflow does for `CONFLICT_BODY`), or indent every
heredoc line to the block’s content indent.

## Operator checklist

1. Add `ADDI_APP_ID` + `ADDI_APP_PRIVATE_KEY` to the repo (or org) secrets/vars.
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
