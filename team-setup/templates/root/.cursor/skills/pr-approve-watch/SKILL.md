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
   **resolve `mergeable=CONFLICTING` if needed**, **triage review comments
   (required — see below)**, then merge, pull the repo default branch
   (`main` or `build-env/dev`), report. If multiple targets remain, leave the
   watcher running (it exits only when all targets have fired).
4. Prefer human (non-bot) Approve. The script uses `reviewDecision == APPROVED`
   when present, else any non-bot `APPROVED` review.
5. **Never merge on Approve alone while unresolved, unaddressed review
   comments remain** (human or bot). Approve means “proceed with the merge
   workflow,” which includes comment hygiene.
6. **Drain wakes even when chat notify is silent** — see Wake delivery below.

## Wake delivery (chat notify is best-effort)

`notify_on_output` often does **not** start a new agent turn after the turn
that armed the watcher has ended. The sentinel still prints to the watcher
terminal:

```text
AGENT_LOOP_WAKE_pr_approve {"target":"Owner/repo#N",...}
```

**Agent duties while a watcher is armed:**

- Before ending a turn: skim armed watcher terminal output (Cursor terminals
  folder / the background shell) for unconsumed `AGENT_LOOP_WAKE_pr_approve`
  lines and process each **now**.
- When the user says they approved, “check watchers”, “process wakes”, or
  similar: that is a proceed nudge — read watcher terminals **and**
  `gh pr view` / `reviewDecision`, then drain any fired or missed wakes.
- Do not claim “no activity” without checking the watcher terminal; silent
  chat ≠ idle watcher.

**Human mitigations:** after Approve, ping the agent (“process watcher wakes”)
if nothing happens within a minute.

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
2. `gh pr view <n> -R <owner/repo> --json state,reviewDecision,statusCheckRollup,mergeable`.
3. If `mergeable` is `CONFLICTING` (or merge fails on conflicts): update the PR
   branch onto its base (merge `origin/<base>` into the head, or rebase when
   appropriate), resolve conflicts, commit with DCO (`-s`), push (use
   force-with-lease only after rebase on a topic branch), wait for CI green
   again. Prefer merge-into-branch when force-push is blocked.
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
7. Brief report: merged URL + what comments were addressed or waived.

## Anti-patterns

- Blocking the chat with a foreground `sleep`/poll loop waiting for Approve.
- Treating chat "LGTM" / "approved" as the proceed signal when an Addi PR exists.
- Redirecting watcher stdout to a file without `tee` (breaks wake notifications).
- Merging immediately on Approve without reading review comments / threads.
- Resolving threads without a reply when the human asked for a change.
- Ending a turn while wakes sit unprocessed in the watcher terminal because
  chat notify did not fire.
- Stopping after Approve when `mergeable=CONFLICTING` — resolve, then merge.
