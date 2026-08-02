# Addi PR automation — gold standard

**Status:** canonical (Rosetta + Comita)  
**Merge authority for human-Approved Addi PRs:** GitHub Actions workflow
`Addi merge on Approve` (`.github/workflows/addi-merge-on-approve.yml`),
acting as the org Addi GitHub App.

This document reconciles overlapping PR automation so agents and humans know
which path owns what.

## Decision table

| Situation                                                                 | Owner                          | Mechanism                                                                       |
| ------------------------------------------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------- |
| Human **Approves** an **Addi-authored** topic PR; checks green; mergeable | **GHA (gold)**                 | `addi-merge-on-approve.yml` merges as Addi                                      |
| Same, but `mergeable=CONFLICTING`                                         | **GHA (gold)**                 | Addi posts conflict comment; no force-merge                                     |
| Human **Requests changes**                                                | **Agent / `pr-approve-watch`** | Fix, push, reply; **do not merge** until Approve                                |
| Review-comment triage (Copilot / human threads)                           | **Agent / `pr-approve-watch`** | Reply + resolve; GHA does not triage comments                                   |
| Agent opens a PR                                                          | **Addi identity**              | `addi-github-identity` / `addi-authorship` — activate App before `gh pr create` |
| Comita **Jira ticket → code → PR → merge** (no human Approve)             | **`process-ticket.yml`**       | Separate automation; keep. Not replaceable by merge-on-approve                  |
| Comita merge to `build-env/dev` → Jira Done                               | **`ticket-done-on-merge.yml`** | Keep. Orthogonal                                                                |
| Comita promote / deploy                                                   | **deploy / promote workflows** | Keep. Orthogonal                                                                |

## What is deprecated / demoted

| Old pattern                                                                   | New rule                                                                                                                   |
| ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| IDE `pr-approve-watch` **merges** on Approve when GHA is enabled for the repo | **Do not merge from the watch.** Arm the watch for **Request changes** + **comment triage** only; let GHA merge on Approve |
| Relying only on `pull_request_review` Actions delivery                        | Treat as best-effort. Prefer App webhook → `repository_dispatch` (`addi-merge-on-approve`)                                 |
| Ambient human `gh pr create` for agent work                                   | Forbidden — see authorship rules                                                                                           |

Spike notes and historical troubleshooting remain in
[`addi-merge-on-approve-spike.md`](./addi-merge-on-approve-spike.md).

## Triggers (reliability order)

1. **`repository_dispatch` type `addi-merge-on-approve`** — preferred.
   Payload: `{ "pr_number": <n> }`. Emitted by the Addi App **webhook bridge**
   (`team-setup/addi-merge-webhook/`) when it receives `pull_request_review`
   with `state=approved`.
2. **`workflow_run`** on successful `CI` / `PR Checks` — retries Approved Addi
   PRs after green checks (Approve-then-CI).
3. **`pull_request_review` / `submitted`** — best-effort; sometimes does not
   start a run.
4. **`schedule` every 10 minutes** — last-resort poll (GitHub may delay or skip
   schedules on quiet repos).
5. **`workflow_dispatch`** with `pr_number` — manual / proof.

## Credentials

Each org has **its own** Addi GitHub App (separate Client ID + PEM). Do not
cross-wire Rosetta credentials into Comita Actions (or the reverse).

| Name                    | Kind     | Purpose                                                                                         |
| ----------------------- | -------- | ----------------------------------------------------------------------------------------------- |
| `ADDI_CLIENT_ID`        | variable | Org Addi App Client ID (`client-id` for `create-github-app-token@v3`; also preferred JWT `iss`) |
| `ADDI_APP_PRIVATE_KEY`  | secret   | Matching org Addi App PEM                                                                       |
| `ADDI_MERGE_ON_APPROVE` | variable | `true` to enable the job                                                                        |
| `ADDI_MERGE_ANY_AUTHOR` | variable | optional test override                                                                          |

| Org                | App slug / bot login                         | Local activate                             | Org Actions vars/secrets                           |
| ------------------ | -------------------------------------------- | ------------------------------------------ | -------------------------------------------------- |
| Rosetta-Foundation | `rosetta-s-addi-m` → `rosetta-s-addi-m[bot]` | `~/.config/rosetta/github-app-activate.sh` | `ADDI_CLIENT_ID` + `ADDI_APP_PRIVATE_KEY`          |
| Comita-Health      | `addi-m` → `addi-m[bot]`                     | `~/.config/comita/github-app-activate.sh`  | same **names**, Comita App values (already on org) |

Author logins accepted by the workflow: `app/addi-m`, `addi-m[bot]`,
`app/rosetta-s-addi-m`, `rosetta-s-addi-m[bot]` (and bare slug forms).

**Not the same as** Comita `COMITA_APP_*` used by `process-ticket.yml` (Jira →
agent → auto-merge). Keep both; merge-on-approve only handles human Approve of
Addi topic PRs.

## Webhook bridge (required for reliable Approve delivery)

GitHub App webhooks cannot start Actions by themselves. Run
`team-setup/addi-merge-webhook` (or an equivalent mirror such as GitHub’s
unofficial [event-mirror Azure Function](https://github.com/github/github-event-mirror-azure-function))
and point the Addi App’s webhook URL at it.

Bridge duties:

1. Verify `X-Hub-Signature-256` with the App webhook secret.
2. On `pull_request_review` + `action=submitted` + `review.state=approved`,
   mint an installation token and
   `POST /repos/{owner}/{repo}/dispatches` with
   `event_type=addi-merge-on-approve` and `client_payload.pr_number`.

See `team-setup/addi-merge-webhook/README.md` for run/deploy.

## Comita vs Rosetta

|                     | Rosetta-Foundation                         | Comita-Health                                             |
| ------------------- | ------------------------------------------ | --------------------------------------------------------- |
| App                 | `rosetta-s-addi-m` / `addi-m`              | `addi-m`                                                  |
| Activate            | `~/.config/rosetta/github-app-activate.sh` | `~/.config/comita/github-app-activate.sh`                 |
| Pilot repos         | `rosetta_dev-scripts`                      | `rosetta_dev-scripts`, then `comita_admissions`           |
| Default branch      | `main`                                     | admissions: `build-env/dev` (workflow is branch-agnostic) |
| Extra PR automation | —                                          | Keep `process-ticket` / `ticket-done-on-merge` / deploy   |

## Rollout checklist (per org)

1. Set org (or repo) `ADDI_CLIENT_ID`, `ADDI_APP_PRIVATE_KEY`,
   `ADDI_MERGE_ON_APPROVE=true`.
2. Land `addi-merge-on-approve.yml` on the repo default branch.
3. Deploy webhook bridge; subscribe App to **Pull request reviews**; set webhook
   URL + secret.
4. Update agent rules via team-setup so `pr-approve-watch` does not merge when
   GHA is enabled.
5. Proof: Addi PR → Approve → merge as Addi without manual `workflow_dispatch`.
