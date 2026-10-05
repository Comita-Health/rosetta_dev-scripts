---
name: local-delivery
description: >-
  Default delivery loop for repos whose .sdlc/environments.json sets
  ci.mode=local: plan, TDD commits, full local CI (incl. CDK synth
  comparison), open the PR as Addi, run an independent reviewer subagent,
  fix findings, then deploy to the sandbox from the laptop. Use for every
  PR in a local-mode repo, after drop arm and before pr-approve-watch.
---

# Local delivery (laptop CI + sandbox deploy)

GitHub Actions minutes cost real money. In local-mode repos the per-PR
gate is the laptop: tests run here, a fresh subagent reviews the PR, and
the sandbox deploys from here. Actions runs the full suite once a day and
deploys prod on promote. The repo's merge-on-approve workflow requires the
`local-ci` commit status this loop posts.

## When

- The target repo's `.sdlc/environments.json` has `"ci": { "mode": "local" }`.
- Any PR there: drops (`sdlc-drop`), fixes, docs that touch code paths.
- Repos without a `ci` block, or `ci.mode == "gha"`, keep using
  `pr-checks-watch` and `deploy-verify-watch` instead.

## Read the contract (never hard-code repo commands)

```bash
CI=$(jq -r .ci.command .sdlc/environments.json)            # posts the local-ci status
DEPLOY=$(jq -r .sandbox.deployCommand .sdlc/environments.json)
CHECKLIST=$(jq -r .ci.reviewChecklist .sdlc/environments.json)
```

Product repos also ship the scripts behind those commands, e.g.
`scripts/local-delivery/local-ci.sh` and `scripts/local-delivery/deploy.sh`.
Read their `--help` once per session.

## The loop

**a. Plan.** Restate the issue's Done-when, then list the commits you will
make. One drop = one PR; tasks are commits.

**b. TDD commits.** For each commit: failing test → run it red → implement →
run it green → `git commit -s`. Conventional Commits, Addi identity.

**c. Local CI.** Run the CI command **without** `--post-status` until green:

```bash
bash scripts/local-delivery/local-ci.sh            # path-aware; --all for everything
```

It runs commitlint, workflow guards, lint, unit tests, builds, and the CDK
snapshot tests (the synth comparison). Snapshot drift stops it: update
snapshots only for an intended stack change, review the `.snap` diff, and
commit it on its own. Long runs go in the background; wait with the
shell-await tool, never `sleep`.

**d. Open the PR.** `drop --finish --require-approve` (or push + `gh pr
create` as Addi), then run `$CI` so it posts the `local-ci` status for the
pushed head. Replace the PR body with the repo's template (Local CI, CDK
synth comparison, Local review, Sandbox, Release notes, Architecture docs)
via `gh api -X PATCH repos/<o>/<r>/pulls/<n> -F body=@file`.

**e. Independent review.** Launch a **fresh** subagent (Cursor Task tool,
`subagent_type: generalPurpose`; Claude Code Task tool) with
`reviewer-prompt.md` filled in:

- the PR URL and the full `gh pr diff <n>`
- the contents of `$CHECKLIST`
- the issue's Done-when text

Give it no implementation chat — independence is the point. Tell it to read
files but change nothing. It returns JSON
`{ verdict, findings: [{ severity, file, line, finding, fix }] }`.
Post one Addi PR comment headed `## Local review (round N)` listing the
findings.

**f. Fix.** Fix every `blocker` and `major`; fix a `minor` when it takes
under 10 minutes; `nit` is optional. Commit, `git push`, re-run `$CI`
(posts the new status), and reply on the review comment with the fix
SHAs. Round 2 is a **new** fresh subagent. If blockers or majors remain
after round 2, stop and ask the human.

**g. Deploy to the sandbox.** Run the deploy command in the background and
wait for its last line:

```bash
bash scripts/local-delivery/deploy.sh --env dev --groups auto
# … LOCAL_DEPLOY_GREEN sha=<sha>   |   LOCAL_DEPLOY_FAILED step=<step> sha=<sha>
```

Up to 45 minutes. On FAILED: read the log under `.tmp/local-delivery/<sha>/`,
fix, push, re-run (max 3). Exit 3 means a guard tripped (an env var would be
blanked, or the diff destroys/replaces a table, user pool, certificate, or
hosted zone) — stop and ask the human. Pass `--publish-verify` only on the
final head, so the stakeholder smoke thread posts once.

Then arm **`pr-approve-watch`**. Approve is still the proceed signal; do not
merge from the agent when merge-on-approve is enabled.

## AWS sign-in

When an AWS step reports an expired session, run the workspace's SSO login
in the background (`aws sso login --profile "${COMITA_SSO_PROFILE:-<workspace
default>}"`), tell the human in one line that a browser sign-in is waiting,
and poll `aws sts get-caller-identity` every 15 s for up to 10 minutes. The
product scripts start the sign-in themselves when they can.

## Anti-patterns

- Arming `pr-checks-watch` or `deploy-verify-watch` in a local-mode repo
  (they wait on Actions that no longer run per PR).
- Dispatching the deploy workflow "just to be safe" — that is the cost this
  loop removes.
- Reviewing your own diff in the same context instead of a fresh subagent.
- Posting `local-ci` success without running the suite on that exact head.
- `--publish-verify` on every redeploy (duplicate Slack threads).
