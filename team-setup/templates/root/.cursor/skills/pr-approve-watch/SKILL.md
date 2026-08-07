---
name: pr-approve-watch
description: >-
  Background-watch Addi-authored (or other agent) PRs for human GitHub review
  signals — Approve or Request changes — then wake the agent to triage comments
  (and merge only when GHA Addi merge-on-approve is not enabled). Use when
  opening PRs that await human review, or when the user asks to watch for
  approval / request-changes / proceed-on-approve.
---

# PR review watch (Approve + Request changes)

**Human feedback on agent PRs lives on the PR** — not in chat. Arm this skill
so Approve **or** Request changes wakes the agent without a chat nudge.

Transport (SPEC-PRD-0020-P1 T-08): the skill script is a **thin daemon
client**. It registers durable `pr-review` watches via
`sdlc-workflow daemon watch` and prints `daemon status`, then **exits**. The
workspace daemon owns the poll loop and wake inbox — do not background a
local bash poller.

| Signal | Wake | After wake |
| ------ | ---- | ---------- |
| **Approve** | Once per human APPROVED review | Triage comments; merge only if GHA merge-on-approve is **not** enabled |
| **Request changes** | Once per new human review id | Fix / reply / push — **do not merge**; keep the daemon watch armed |

## Merge authority (gold standard)

When the repo has **Addi merge on Approve** enabled
(`vars.ADDI_MERGE_ON_APPROVE=true` — see
`team-setup/docs/addi-pr-automation-standard.md`):

- **GHA merges** on Approve (as Addi). Do **not** `gh pr merge` from this watch.
- This watch still arms for **Request changes**, **comment triage**, and
  conflict follow-up the agent must resolve before the next Approve.

When GHA is **not** enabled for the repo, keep the legacy wake → triage →
merge path below.

## Hard rules

1. After `gh pr create` (or when the user asks to watch), run the skill
   script **once** (foreground is fine — it exits after register+status):
   `.cursor/skills/pr-approve-watch/scripts/watch-pr-approve.sh` (Claude
   Code mirror: `.claude/skills/pr-approve-watch/scripts/watch-pr-approve.sh`
   — same bytes after team-setup sync).
2. Do **not** leave a long-lived skill process running. Polling is the
   daemon's job (`sdlc-workflow daemon` / launchd agent).
3. Drain wakes from `sdlc-workflow daemon status` (or the durable wake
   inbox). Daemon notify may also print `AGENT_LOOP_WAKE_pr-review` on the
   daemon log — treat that as a best-effort chat mirror.
4. Read wake JSON `signal` / `data.signal`: `"approved"` or
   `"changes_requested"` (review-comment wakes are informational).
5. Prefer human (non-bot) reviews — the daemon `pr-review` adapter already
   filters bots.
6. **Never merge on `changes_requested`.** Fix the feedback; the watch stays
   registered until the PR reaches a terminal state.
7. **Never merge on Approve alone while unresolved, unaddressed review
   comments remain** (human or bot).
8. **Drain wakes even when chat notify is silent** — see Wake delivery below.

## Wake delivery (chat notify is best-effort)

The daemon's notify action may print:

```text
AGENT_LOOP_WAKE_pr-review {"signal":"approved:…","data":{"signal":"approved",…},…}
```

`notify_on_output` on the daemon log often does **not** start a new agent
turn. Durable truth is the wake inbox + `daemon status`.

**Agent duties while watches are armed:**

- Before ending a turn: run
  `sdlc-workflow daemon status --workspace <root> --json` (or the human
  table) and process any pending / newly consumed `pr-review` wakes.
- When the user says they approved, “check watchers”, “process wakes”, or
  similar: that is a proceed nudge — read `daemon status` **and**
  `gh pr view` / `reviewDecision`, then drain any fired or missed wakes.
- Do not claim “no activity” without checking status; silent chat ≠ idle
  daemon.

**Human mitigations:** after Approve, ping the agent (“process watcher wakes”)
if nothing happens within a minute.

## Launch template

```bash
# From workspace root (paths work after team-setup update-config).
# Script registers with the daemon and exits — do not background it.
bash .cursor/skills/pr-approve-watch/scripts/watch-pr-approve.sh --interval 30 \
  Owner/repo#123 \
  Owner/other#456
```

Claude Code: the same script under
`.claude/skills/pr-approve-watch/scripts/watch-pr-approve.sh`.

Optional: `--workspace <root>` (default: `ROSETTA_WORKSPACE`, else the
workspace that contains this skill / `.sdlc/daemon.json`). Optional:
`--engine <path-to-sdlc-workflow>` (default: `$WORKSPACE/rosetta_dev-scripts/sdlc-workflow`
or `SDLC_WORKFLOW_ENGINE`). Legacy `--activate` is ignored — daemon auth
comes from `.sdlc/daemon.json` `activateScript`.

Confirm coverage:

```bash
cd "$WORKSPACE/rosetta_dev-scripts/sdlc-workflow"
bunx tsx src/index.ts daemon status --workspace "$WORKSPACE"
```

## On wake — `signal: changes_requested`

1. Activate the workspace GitHub App.
2. Fetch the Request changes review body + inline comments + unresolved
   `reviewThreads`.
3. Fix actionable items on the PR branch; commit; push.
4. Reply on each thread with the fix SHA; `resolveReviewThread` when done.
5. Wait for CI green after pushes.
6. **Do not merge.** Report what you fixed and that the PR awaits re-review.
7. Leave the daemon watch registered (it keeps the target until Approve /
   terminal PR state).

## On wake — `signal: approved`

1. `eval "$(bash ~/.config/rosetta/github-app-activate.sh)"` by default, or
   use the consumer workspace's `~/.config/<workspace>/github-app-activate.sh`.
2. `gh pr view <n> -R <owner/repo> --json state,reviewDecision,statusCheckRollup,mergeable`.
3. If `mergeable` is `CONFLICTING` (or merge fails on conflicts): update the PR
   branch onto its base (merge `origin/<base>` into the head, or rebase when
   appropriate), resolve conflicts, commit with DCO (`-s`), push (use
   force-with-lease only after rebase on a topic branch), wait for CI green
   again. Prefer merge-into-branch when force-push is blocked. Stacked PRs:
   fix the **bottom** PR first; use **merge commits** (never squash a stack).
4. **Review-comment cycle (before merge / before yielding to GHA):**
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
   7. If fixes were pushed, wait for CI green again before merge (legacy path)
      or before the next GHA merge attempt.
   8. Run this cycle **once** per wake; new bot comments on the fix commit
      → flag for human rather than looping.
5. **Merge authority:** if `vars.ADDI_MERGE_ON_APPROVE=true` for the repo,
   **stop after triage** — do not `gh pr merge`; GHA merges as Addi. Otherwise
   merge when checks are green and triage is done (`gh pr merge` — stacked PRs
   need merge commits, never squash-merge a stack).
6. After a successful merge (agent or GHA):
   `git checkout <default-branch> && git pull --ff-only` in the affected
   local clone (`main` or `build-env/dev` as appropriate).
7. Brief report: merge owner (GHA vs agent) + URL + comments addressed/waived.

## Anti-patterns

- Blocking the chat with a foreground `sleep`/poll loop waiting for Approve.
- Backgrounding this skill script as a long-lived poller (it must exit after
  register).
- Treating chat "LGTM" / "approved" as the proceed signal when an Addi PR exists.
- Merging from the agent when GHA Addi merge-on-approve is enabled for the repo.
- Merging on `changes_requested`.
- Merging immediately on Approve without reading review comments / threads.
- Resolving threads without a reply when the human asked for a change.
- Ending a turn while wakes sit unprocessed in `daemon status` because chat
  notify did not fire.
- Stopping after Approve when `mergeable=CONFLICTING` — resolve tip conflicts
  so GHA (or legacy merge) can proceed.
