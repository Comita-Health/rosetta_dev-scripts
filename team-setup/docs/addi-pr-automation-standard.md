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
| Same, and the PR touches `specs/**/phase-*-spec.md` still `status: Draft` | **GHA (gold)**                 | Before merge, flip script pushes `Draft → Approved` as Addi (DCO, conventional) |
| Same, after merge of a PR that touched `specs/**/phase-*-spec.md`         | **GHA (gold)**                 | Emit `repository_dispatch` type `sdlc-run-launch` (exactly once per merge SHA)  |
| Same, but `mergeable=CONFLICTING`                                         | **GHA + Agent**                | GHA comments only (no force-merge). **Agent** merges/rebases onto base, pushes  |
| Stacked PR (`pull.stack` set), Approved + mergeable                       | **GHA (gold)**                 | `PUT .../merge-async` with `merge_method=merge` (sync `gh pr merge` fails)      |
| Stack blocked because a **lower** PR is CONFLICTING                       | **Agent / human**              | Fix bottom-up; GHA comments only — does not auto-resolve conflicts              |
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

Inbound (start merge-on-approve):

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

Outbound (after a successful spec-PR merge):

6. **`repository_dispatch` type `sdlc-run-launch`** — emitted by this workflow
   (not an inbound trigger). See [Spec run-launch signal](#spec-run-launch-signal-after-merge)
   for payload schema, exactly-once semantics, and intended consumer.

### Spec status flip (before merge)

When the Approved PR includes `specs/**/phase-*-spec.md` still at
`status: Draft`, the merge job runs this sequence with no human step between
Approve and merge:

1. **Detect** — read-only PR file list + path filter (non-spec PRs stop here:
   no clone, no `node`, prior merge path byte-identical).
2. **Flip commit** — clone, extract `team-setup/scripts/flip-spec-status.mjs`
   from the **trusted default-branch HEAD** (never the PR head), check out the
   PR branch, rewrite only `status: Draft` → `Approved`, push as Addi
   (`docs(spec): approve SPEC-… on human Approve`, DCO-signed).
3. **Head re-pin** — wait until `headRefOid` matches the flip SHA.
4. **Checks → merge** — existing statusCheckRollup wait, then squash /
   merge-async as before.

Tests: `node --test team-setup/scripts/flip-spec-status.test.mjs`.

### Spec run-launch signal (after merge)

After merge-on-approve merges a PR whose diff includes
`specs/**/phase-*-spec.md`, the job emits a `repository_dispatch` so a
downstream consumer can start `sdlc-workflow run` without a chat "proceed":

| Field                      | Value                                                                               |
| -------------------------- | ----------------------------------------------------------------------------------- |
| `event_type`               | `sdlc-run-launch`                                                                   |
| `client_payload.specPaths` | `string[]` — every `specs/**/phase-*-spec.md` path in the merged diff (non-removed) |
| `client_payload.mergedSha` | `string` — merge commit OID                                                         |
| `client_payload.prNumber`  | `number` — merged PR number                                                         |

**Exactly-once (at-most-once claim):** dedup by `mergedSha`. The workflow
reads existing `sdlc-run-launch` commit statuses on the merge SHA
(pagination-safe line count) and passes them to the planner via
`--emitted-sha`; the planner owns the noop decision. Before the dispatch
POST the workflow **claims** the marker (`state=pending` on the same
context), then dispatches, then records `state=success` — so schedule /
`workflow_run` retries and already-`MERGED` re-entries never double-fire.
A claim whose dispatch fails aborts the job loudly for deliberate
retrigger. Non-spec merges never POST.

**Intended consumer:** PRD-0020 event daemon (watch kinds `workflow-run` /
`issue-state`) launches `sdlc-workflow run` for the approved spec. Until that
daemon ships, operators can observe the launch record via
`gh api /repos/{owner}/{repo}/dispatches` consumers; the continuity daemon's
poll loop is documented to treat this signal as the run-start cue.

Planner tests: `node --test team-setup/scripts/emit-sdlc-run-launch.test.mjs`.

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
`team-setup/addi-merge-webhook` (AWS Lambda Function URL in `comita-dev`)
and deliver **`pull_request_review`** events to it.

**Preferred delivery (current):** org webhooks created by the Addi App
installation (`organization_hooks: write`) — App webhook config stays 404
until “Active” is toggled in the App settings UI.

| Org                | Webhook path       |
| ------------------ | ------------------ |
| Rosetta-Foundation | `/webhook/rosetta` |
| Comita-Health      | `/webhook/comita`  |

Bridge duties:

1. Verify `X-Hub-Signature-256` with the per-tenant webhook secret.
2. On `pull_request_review` + `action=submitted` + `review.state=approved`,
   mint an installation token and
   `POST /repos/{owner}/{repo}/dispatches` with
   `event_type=addi-merge-on-approve` and `client_payload.pr_number`.

Deploy: `cd team-setup/addi-merge-webhook && bun run deploy`
(see `team-setup/addi-merge-webhook/README.md`).

Production Function URL (`comita-dev` / `us-east-1`):
`https://kfjifzn4cza53dmr4xqdcrgk4m0ugopm.lambda-url.us-east-1.on.aws`

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
3. Deploy webhook bridge (`bun run deploy` in `addi-merge-webhook`); ensure org
   hooks for **Pull request reviews** point at `/webhook/{rosetta|comita}`.
4. Update agent rules via team-setup so `pr-approve-watch` does not merge when
   GHA is enabled.
5. Proof: Addi PR → Approve → merge as Addi without manual `workflow_dispatch`.
