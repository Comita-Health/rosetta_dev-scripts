---
name: deploy-verify-watch
description: >-
  Background-watch live-verify PRs: classify auth/multi-SPA/deploy changes,
  auto-dispatch Deploy Organization (or configured workflow) on each new head
  SHA, and wake the agent when the deploy finishes so a human can re-smoke
  before Approve/merge. Use when opening or pushing to PRs that need host
  verification, or when the user asks to watch deploy-verify.
---

# Deploy verify watch (live smoke before land)

**Some PRs cannot be trusted on CI alone.** Auth handoffs, logout/`redirect_uri`,
cookie SSO, multi-SPA cutovers, and Deploy Org wiring need a real **dev** host
smoke after each push — before Approve/merge.

This skill closes the gap where PR Checks re-run on push but **no deploy**
fires until a human asks in chat.

## When a PR is "live-verify"

Arm this watcher when any of these are true (script `--classify` encodes the
same heuristics):

| Signal | Examples |
| ------ | -------- |
| Label | `verify-live` or `live-verify` |
| Paths | `accounts-frontend`, `AccountsAuthRedirect`, `accounts-redirect`, `return-to`, `session-expiry`, `deploy-organization.yml`, `frontend-accounts-stack`, `frontend-app.ts` |
| Title/body | `redirect_uri`, logout, cookie, SSO, Phase 0e, cutover, post-login, `accounts.dev` / `admit.dev` |

When unsure, arm anyway and/or add the `verify-live` label.

## Hard rules

1. After opening or pushing to a live-verify PR (or when the user asks), start
   `.cursor/skills/deploy-verify-watch/scripts/watch-deploy-verify.sh` in the **background** with agent
   `notify_on_output` on `^AGENT_LOOP_WAKE_deploy_verify`.
2. Do **not** redirect watcher stdout away from the monitored terminal.
3. Prefer `--dispatch-on-arm` (or default `--auto-dispatch`) so the **current**
   head gets a deploy without waiting for another push.
4. On `deploy_green`: tell the human the SHA/environment is ready to re-smoke;
   do **not** merge on green alone — Approve remains the merge proceed signal
   (`pr-approve-watch`). If the operator **directly linked a Slack
   message/thread** when requesting the work (issue Source permalink, or
   the cataloging chat), reply **in that same thread** that a new update
   for the issue has been deployed to **SB** (sandbox — the DEV hosts;
   do not say “dev” to stakeholders). No `@channel`. PHI-free. Include
   the issue URL and host. Do this in addition to Cursor chat and Slack
   **Sandbox verify** publish. Do **not** reply on git push or CI green.
5. On `deploy_failed`: remediate (logs → fix → push). The watcher re-dispatches
   on the new SHA.
6. After any fix that invalidates a prior smoke, **do not wait for chat** —
   push and keep this watcher armed (auto-dispatch handles the redeploy).
7. Pair with `pr-approve-watch` for Approve → triage → merge.

## Launch template

```bash
# From workspace root (paths work after team-setup update-config)
bash .cursor/skills/deploy-verify-watch/scripts/watch-deploy-verify.sh \
  --interval 30 \
  --activate ~/.config/rosetta/github-app-activate.sh \
  --workflow "Deploy Organization" \
  --environment dev \
  --frontend \
  --dispatch-on-arm \
  --kickoff \
  Rosetta-Foundation/rosetta_dev-scripts#1
```

Classify only:

```bash
bash .cursor/skills/deploy-verify-watch/scripts/watch-deploy-verify.sh \
  --classify Rosetta-Foundation/rosetta_dev-scripts#1
# exit 0 = needs live verify
```

Optional: `--activate ~/.config/<workspace>/github-app-activate.sh` for a
consumer workspace.
`--no-auto-dispatch` if you will dispatch manually but still want completion wakes.

## On wake

1. `eval "$(bash ~/.config/rosetta/github-app-activate.sh)"` by default, or
   use the consumer workspace's `~/.config/<workspace>/github-app-activate.sh`.
2. Read the wake JSON (`reason`, `sha`, `runUrl`, `target`).
3. Act by reason:
   - `kickoff` / `deploy_dispatched` / `head_pushed`: wait for deploy outcome
     unless remediation is already needed; do not ping the human to smoke yet.
   - `deploy_green`: notify human — re-smoke on the live **SB** (sandbox)
     hosts for this SHA; link the Actions run. Keep `pr-approve-watch`
     armed for Approve. If this SHA addresses an issue/item the operator
     **linked in Slack**, `chat.postMessage` on that thread: a new update
     for {issue} has been deployed to SB. No `@channel`. PHI-free. One
     reply per originating thread (several issues → several threads).
   - `deploy_failed`: `gh run view <id> --log-failed`, fix, commit, push.
   - `pr_merged` / `pr_closed`: brief report; drop this target.
4. Never treat deploy green as permission to merge.

## Anti-patterns

- Assuming PR Checks = deployed to `admit.dev` / `accounts.dev`.
- Waiting for the human to ask "is it redeployed?" after you pushed a fix.
- Merging on deploy green without Approve + review-comment triage.
- Swallowing wake sentinels by redirecting watcher stdout.
- Skipping the originating Slack thread when the operator linked it as
  the ask — Cursor chat alone is not enough for those items.
- Saying “deployed to dev” in Slack; stakeholders call DEV **SB** /
  **Sandbox**. Slack **Sandbox verify** is Bret’s smoke list — do not
  mix that `@channel` publish with a thread reply.
