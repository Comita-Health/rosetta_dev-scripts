---
name: pr-approve-watch
description: >-
  Background-watch Addi-authored (or other agent) PRs for a human GitHub
  Approve proceed signal, then wake the agent to triage review comments,
  merge, and continue. Use when opening PRs that await human Approve, or
  when the user asks to watch for approval / proceed-on-approve.
---

# PR Approve watch (proceed signal)

**Proceed signal for agent work is GitHub PR Approve** — not chat "approved".
When you open a PR that needs a human proceed (especially Addi / bot-authored
PRs), arm this watcher so Approve can be acted on without a chat nudge.

## Hard rules

1. After `gh pr create` (or when the user asks to watch), start
   `scripts/watch-pr-approve.sh` in the **background** with agent
   `notify_on_output` on `^AGENT_LOOP_WAKE_pr_approve`.
2. Do **not** redirect the watcher stdout away from the monitored terminal
   (or the wake sentinel will be swallowed).
3. On wake: activate the workspace GitHub App, verify APPROVED + green checks,
   **resolve merge conflicts if `mergeable=CONFLICTING`**, **triage review
   comments (required — see below)**, then merge, pull the repo default
   branch (`main` or `build-env/dev`), report. If multiple targets remain,
   leave the watcher running (it exits only when all targets have fired).
4. Prefer human (non-bot) Approve. The script uses `reviewDecision == APPROVED`
   when present, else any non-bot `APPROVED` review.
5. **Never merge on Approve alone while unresolved, unaddressed review
   comments remain** (human or bot). Approve means “proceed with the merge
   workflow,” which includes comment hygiene.

## Launch template

```bash
# From workspace root (paths work after team-setup update-config)
bash .cursor/skills/pr-approve-watch/scripts/watch-pr-approve.sh --interval 30 \
  Owner/repo#123 \
  Owner/other#456
```

Optional: `--activate ~/.config/rosetta/github-app-activate.sh` (Rosetta) or
`~/.config/comita/github-app-activate.sh` (Comita). If omitted, the script
picks from cwd / `ROSETTA_GH_ACTIVATE` / those defaults, else ambient `gh` auth.

Cursor agent loop: background the command with
`notify_on_output` pattern `^AGENT_LOOP_WAKE_pr_approve`.

## On wake

1. `eval "$(bash ~/.config/<rosetta|comita>/github-app-activate.sh)"` when present.
2. `gh pr view <n> -R <owner/repo> --json state,reviewDecision,statusCheckRollup,mergeable,mergeStateStatus`.

3. **If `mergeable` is `CONFLICTING` (or mergeStateStatus is `DIRTY`):** do **not**
   stop or wait for the human. Resolve on the PR branch:
   1. `git fetch origin <base> && git checkout <head> && git rebase origin/<base>`
      (or merge `origin/<base>` if rebase is inappropriate).
   2. Resolve conflicts; keep the intentional PR change; drop duplicate history
      that already landed on base (prefer a clean tip over replaying merged
      parent stacks).
   3. `git push` (force-with-lease only on the PR head branch after rebase).
   4. Re-check CI; continue the review-comment cycle, then merge.
   5. If conflicts need a human product decision, comment on the PR and ping —
      otherwise auto-resolve mechanical conflicts.

4. **Review-comment cycle (before merge):**
   1. Fetch inline threads:
      `gh api repos/{owner}/{repo}/pulls/{n}/comments`
   2. Fetch review bodies:
      `gh api repos/{owner}/{repo}/pulls/{n}/reviews`
   3. Fetch issue comments if useful:
      `gh api repos/{owner}/{repo}/issues/{n}/comments`
   4. List unresolved threads via GraphQL `reviewThreads` (`isResolved`).
   5. For each actionable comment (correctness, missing docs, real gaps):
      fix on the PR branch, commit, push; reply with the fix commit SHA and a
      brief explanation; resolve the thread with GraphQL
      `resolveReviewThread`.
   6. For noise / false positives: reply briefly why no change, then resolve
      (or leave open only if the human must decide — and **do not merge**
      until they do).
   7. If fixes were pushed, wait for CI green again before merge.
   8. Run this cycle **once** per wake; new bot comments on the fix commit
      → flag for human rather than looping.
5. Merge when checks are green and comment triage is done (`gh pr merge` —
   use the repo's normal merge method; stacked PRs need merge commits, never
   squash-merge a stack).
6. `git checkout <default-branch> && git pull --ff-only` in the affected
   local clone (`main` or `build-env/dev` as appropriate).
7. Brief report: merged URL + conflicts resolved (if any) + comments addressed or waived.

## Anti-patterns

- Blocking the chat with a foreground `sleep`/poll loop waiting for Approve.
- Treating chat "LGTM" / "approved" as the proceed signal when an Addi PR exists.
- Redirecting watcher stdout to a file without `tee` (breaks wake notifications).
- Merging immediately on Approve without reading review comments / threads.
- Giving up on `CONFLICTING` PRs after Approve — resolve (or ask only when product judgment is required), then merge.
- Resolving threads without a reply when the human asked for a change.
