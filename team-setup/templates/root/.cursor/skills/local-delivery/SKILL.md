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
- **Every** PR there — drops (`sdlc-drop`), fixes, and docs-only PRs. Each
  head needs a `local-ci` status (`ci.statusCommand`) before it can merge.
- Repos without a `ci` block, or `ci.mode == "gha"`, keep using
  `pr-checks-watch` and `deploy-verify-watch` instead.

## The contract (repo commands come from here, not from this skill)

```bash
C=.sdlc/environments.json
CI=$(jq -er .ci.command "$C")                      # local CI; does NOT post
CI_STATUS=$(jq -er .ci.statusCommand "$C")         # same, then posts `local-ci` (HEAD must be pushed)
CHECKLIST=$(jq -r '.ci.reviewChecklist // empty' "$C")   # repo-relative path, may be absent
DEPLOY=$(jq -er .sandbox.localDeployCommand "$C")  # laptop sandbox deploy
# Run them with: bash -c "$CI"   (values are shell command lines)
```

`jq -e` fails loudly when a key is missing; stop and fix the contract rather
than running the literal `null`.

`sandbox.deployCommand` is the SDLC engine's sandbox-gate hook (it needs
engine-provided env); agents use `sandbox.localDeployCommand`.

The laptop deploy command's interface (every local-mode repo implements it):

- accepts `--groups auto|all|<csv>` (default `auto`: what the branch changed),
  `--publish-verify` (post the stakeholder smoke thread), `--dry-run`
- refuses a dirty tree, an unpushed HEAD, or a head without `local-ci: success`
- last line is `LOCAL_DEPLOY_GREEN sha=<sha>`, `LOCAL_DEPLOY_FAILED step=<step> sha=<sha>`,
  or `LOCAL_DEPLOY_DRY_RUN sha=<sha>`
- exit `0` green · `1` failed · `2` preflight refused (dirty tree, unpushed HEAD,
  missing `local-ci`, deploy lock) · `3` a guard tripped (needs a human)
- may leave a CDK context change (for example `cdk.json`) uncommitted with a
  notice; the SHA in the last line is the one deployed

Comita example: `ci.command` = `bash scripts/local-delivery/local-ci.sh`,
`sandbox.localDeployCommand` = `bash scripts/local-delivery/deploy.sh --env dev`;
see that repo's `docs/runbooks/local-delivery.md`.

## The loop

**a. Plan.** Restate the issue's Done-when, then list the commits you will
make. One drop = one PR; tasks are commits.

**b. TDD commits.** For each commit: failing test → run it red → implement →
run it green → `git commit -s`. Conventional Commits, Addi identity.

**c. Local CI.** Launch `$CI_STATUS` in a background subagent (see
**Background runners**). It covers commit messages, guards, lint, unit
tests, builds, and the CDK snapshot tests (the synth comparison).
Snapshot drift stops it: update snapshots only for an intended stack change,
review the `.snap` diff, and commit it on its own. Do not wait for the run
in this turn.

**d. Open the PR.** Local-mode drops are **armed** with
`--require-approve` — the engine stores it in
`~/.rosetta/sdlc-drops/<id>/drop.json` at arm time and ignores it on
`--finish`. Before finishing, confirm
`jq -e .requireApprove ~/.rosetta/sdlc-drops/<id>/drop.json` prints `true`;
if not, open the PR yourself (push + `gh pr create` as Addi) instead of
`--finish`, which would merge immediately. Then launch a background CI
subagent for `bash -c "$CI_STATUS"` so the pushed head gets its `local-ci`
status. Do not wait in this turn. Replace the PR body with the repo's template
(Local CI, CDK synth comparison, Local review, Sandbox, Release notes,
Architecture docs) via `gh api -X PATCH repos/<o>/<r>/pulls/<n> -F body=@file`.

**e. Independent review.** Launch a **fresh** subagent in the **background**
(Cursor Task tool, `subagent_type: generalPurpose`, `run_in_background: true`;
Claude Code Task tool, backgrounded) with `reviewer-prompt.md` filled in.
Do not wait for the verdict in the launch turn. When its completion notice
arrives, post the review comment and continue **f**. Fill in:

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
finding is a bug. Commit, `git push`, launch a new background CI subagent
for `$CI_STATUS` (posts the new status), and reply on the review comment
with the fix SHAs. Round 2 is a
**new** fresh subagent. If blockers or majors remain after round 2, stop and
ask the human.

**g. Deploy to the sandbox.** After that SHA has `local-ci` success, launch
a background deploy subagent (see **Background runners**). Do not wait in
the launch turn. The command:

```bash
bash -c "$DEPLOY --groups auto"   # final head: bash -c "$DEPLOY --groups all --publish-verify"
```

When the deploy subagent's completion notice arrives:

- `LOCAL_DEPLOY_GREEN` → tell the human the sandbox is ready to re-smoke. If
  the operator linked a Slack thread as the ask, reply **in that thread** that
  a new update has been deployed to the sandbox (no `@channel`, PHI-free).
- `LOCAL_DEPLOY_FAILED` → read the deploy's log, fix, push, launch a new
  CI subagent, then a new deploy subagent (max 3).
- Exit `2` → preflight refused, not a code failure: commit or clean the tree,
  push, launch CI again, or wait until the other deploy's subagent finishes,
  then retry.
- A CDK context notice → commit that file on the branch, push, launch CI
  again.
- Exit `3` → a guard tripped (for example an env var would be blanked, or the
  diff destroys or replaces a stateful resource). Stop and ask the human.
- Pass `--publish-verify` only on the final head, after the dated release
  notes are committed on the branch, so the stakeholder thread posts once.

Then arm **`pr-approve-watch`**. Approve is still the proceed signal; do not
merge from the agent when merge-on-approve is enabled.

## Background runners

Local CI and the sandbox deploy take many minutes. Each one runs in its
**own background subagent** so this chat stays free, the same way GitHub
Actions runs a check or a deploy off to the side while the operator keeps
talking.

Cursor: Task tool, `subagent_type: generalPurpose`, `run_in_background: true`.
Claude Code: background the Task tool. One subagent per job. After launch,
tell the operator what is running (CI or deploy, SHA, checkout) in one or
two sentences and **end the turn** unless they already asked for something
else. Do not poll. The completion notice is the proceed signal.

The subagent runs the command and reports the result. It does not edit,
commit, push, or open a PR. Give it the checkout path, the exact command,
and this return shape: exit code, the GREEN/FAILED line, the SHA, and on
failure the step name plus the last error lines (and the log path).

**Local CI.** From the PR checkout, HEAD already pushed:

```bash
bash -c "$CI_STATUS"
```

**Sandbox deploy.** Only after that SHA has `local-ci` success. Same
checkout. The subagent owns an expired AWS session: it starts SSO, says a
browser sign-in is waiting, and waits there.

```bash
bash -c "$DEPLOY --groups auto"
```

A red CI notice comes back to the main agent: read the log, fix, push,
launch another CI subagent. Up to 3 tries on the same failure, then ask.
A green CI notice is not a merge. Continue review or launch the deploy
subagent. A green deploy notice is the cue to tell the operator the
sandbox SHA and what to re-smoke.

## AWS sign-in

When an AWS step reports an expired session, the **deploy subagent** starts
the workspace SSO login and tells the operator, in one line, that a browser
sign-in is waiting. The main thread does not poll for the session.

Comita: `aws sso login --profile "${COMITA_SSO_PROFILE:-bakerorgrwat}"`.
The product scripts start the sign-in themselves when they can. The
subagent may wait on the session; the chat stays open.

## Anti-patterns

- Arming `pr-checks-watch` or `deploy-verify-watch` in a local-mode repo
  (they wait on Actions that no longer run per PR).
- Dispatching the deploy workflow "just to be safe" — that is the cost this
  loop removes.
- Reviewing your own diff in the same context instead of a fresh subagent.
- Posting `local-ci` success without running the suite on that exact head.
- `--publish-verify` on every redeploy (duplicate Slack threads).
- Arming a local-mode drop without `--require-approve` (finish-time flags
  do not change it).
- Blocking the operator chat on local CI, sandbox deploy, review, or SSO
  (shell-await, sleep loops, or polling the subagent). Those waits belong
  to the background subagent. End the turn after launch so the operator
  can keep talking.
