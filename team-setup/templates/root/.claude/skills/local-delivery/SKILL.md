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

## The contract (repo commands come from here, not from this skill)

```bash
C=.sdlc/environments.json
CI=$(jq -r .ci.command "$C")                       # local CI; does NOT post
CI_STATUS=$(jq -r .ci.statusCommand "$C")          # same, then posts `local-ci` (HEAD must be pushed)
CHECKLIST=$(jq -r '.ci.reviewChecklist // empty' "$C")   # repo-relative path, may be absent
DEPLOY=$(jq -r .sandbox.localDeployCommand "$C")   # laptop sandbox deploy
```

`sandbox.deployCommand` is the SDLC engine's sandbox-gate hook (it needs
engine-provided env); agents use `sandbox.localDeployCommand`.

The laptop deploy command's interface (every local-mode repo implements it):

- accepts `--groups auto|all|<csv>` (default `auto`: what the branch changed),
  `--publish-verify` (post the stakeholder smoke thread), `--dry-run`
- refuses a dirty tree, an unpushed HEAD, or a head without `local-ci: success`
- last line is `LOCAL_DEPLOY_GREEN sha=<sha>`, `LOCAL_DEPLOY_FAILED step=<step> sha=<sha>`,
  or `LOCAL_DEPLOY_DRY_RUN sha=<sha>`
- exit `0` green · `1` failed · `2` preflight refused · `3` a guard tripped (needs a human)

Comita example: `ci.command` = `bash scripts/local-delivery/local-ci.sh`,
`sandbox.localDeployCommand` = `bash scripts/local-delivery/deploy.sh --env dev`;
see that repo's `docs/runbooks/local-delivery.md`.

## The loop

**a. Plan.** Restate the issue's Done-when, then list the commits you will
make. One drop = one PR; tasks are commits.

**b. TDD commits.** For each commit: failing test → run it red → implement →
run it green → `git commit -s`. Conventional Commits, Addi identity.

**c. Local CI.** Run `$CI` until green. It covers commit messages, guards,
lint, unit tests, builds, and the CDK snapshot tests (the synth comparison).
Snapshot drift stops it: update snapshots only for an intended stack change,
review the `.snap` diff, and commit it on its own. Long runs go in the
background; wait with the shell-await tool, never `sleep`.

**d. Open the PR.** `drop --finish --require-approve` (always pass
`--require-approve` in local-mode repos, so nothing merges before review and
deploy), or push + `gh pr create` as Addi. Then run `$CI_STATUS` so the pushed
head gets its `local-ci` status. Replace the PR body with the repo's template
(Local CI, CDK synth comparison, Local review, Sandbox, Release notes,
Architecture docs) via `gh api -X PATCH repos/<o>/<r>/pulls/<n> -F body=@file`.

**e. Independent review.** Launch a **fresh** subagent (Cursor Task tool,
`subagent_type: generalPurpose`; Claude Code Task tool) with
`reviewer-prompt.md` filled in:

- `{{CHECKOUT_PATH}}`: the worktree with the PR head checked out
- `{{PR_URL}}` and `{{GH_PR_DIFF}}`: the full `gh pr diff <n>`, or tell the
  reviewer to fetch it itself when it is very large
- `{{REVIEW_CHECKLIST}}`: the contents of `$CHECKLIST`, or
  "No repo checklist; apply general judgment." when it is absent
- `{{DONE_WHEN}}`: the issue's Done-when text

Give it no implementation chat — independence is the point. It reads files
but changes nothing, and returns JSON
`{ verdict, summary, findings: [{ severity, file, line, finding, fix }] }`.
Post one Addi PR comment headed `## Local review (round N)` listing the
findings.

**f. Fix.** Fix every `blocker` and `major`; fix a `minor` when it takes
under 10 minutes; `nit` is optional. Write a failing test first when the
finding is a bug. Commit, `git push`, run `$CI_STATUS` (posts the new
status), and reply on the review comment with the fix SHAs. Round 2 is a
**new** fresh subagent. If blockers or majors remain after round 2, stop and
ask the human.

**g. Deploy to the sandbox.** Run `$DEPLOY` in the background and wait for
its last line (up to 45 minutes):

```bash
$DEPLOY --groups auto        # final head: $DEPLOY --groups all --publish-verify
```

- `LOCAL_DEPLOY_GREEN` → tell the human the sandbox is ready to re-smoke. If
  the operator linked a Slack thread as the ask, reply **in that thread** that
  a new update has been deployed to the sandbox (no `@channel`, PHI-free).
- `LOCAL_DEPLOY_FAILED` → read the deploy's log, fix, push, re-run (max 3).
- Exit `3` → a guard tripped (for example an env var would be blanked, or the
  diff destroys or replaces a stateful resource). Stop and ask the human.
- Pass `--publish-verify` only on the final head, after the dated release
  notes are committed on the branch, so the stakeholder thread posts once.

Then arm **`pr-approve-watch`**. Approve is still the proceed signal; do not
merge from the agent when merge-on-approve is enabled.

## AWS sign-in

When an AWS step reports an expired session, start the workspace's SSO login
in a **background** shell — Comita workspaces:
`aws sso login --profile "${COMITA_SSO_PROFILE:-bakerorgrwat}"` — and tell
the human in one line that a browser sign-in is waiting. Then run a
background check, `until aws sts get-caller-identity --profile "${AWS_PROFILE:-comita-dev}"; do sleep 15; done`,
and wait on it with the shell-await tool (10 minutes max). The product
scripts start the sign-in themselves when they can.

## Anti-patterns

- Arming `pr-checks-watch` or `deploy-verify-watch` in a local-mode repo
  (they wait on Actions that no longer run per PR).
- Dispatching the deploy workflow "just to be safe" — that is the cost this
  loop removes.
- Reviewing your own diff in the same context instead of a fresh subagent.
- Posting `local-ci` success without running the suite on that exact head.
- `--publish-verify` on every redeploy (duplicate Slack threads).
- `drop --finish` without `--require-approve` in a local-mode repo.
