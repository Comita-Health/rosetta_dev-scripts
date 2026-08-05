---
name: issue-resolve-watch
description: >-
  Background-watch GitHub issues for actionable events (kickoff, human
  comments, linked PRs, close), then wake the agent to drive each issue to
  resolution. Use when taking ownership of an issue, after recreating an
  issue as Addi, or when the user asks to watch issues toward Done-when.
---

# Issue resolve watch

**Watched issues work toward resolution by default** — not parking lots.
Arm this watcher so human comments, linked PRs, and close events nudge the
agent without a chat ping. Prefer closing when the issue’s Done-when (or
equivalent acceptance) is met.

## What we watch for

| Reason           | Meaning                                              |
| ---------------- | ---------------------------------------------------- |
| `kickoff`        | `--kickoff` at arm time — start / resume work now    |
| `human_comment`  | New non-bot issue comment                            |
| `linked_pr`      | Timeline cross-ref / connected PR activity           |
| `closed`         | Issue closed (confirm Done-when; report)             |

Exit when every target has closed (after a `closed` wake).

## Hard rules

1. After taking ownership of an issue (or when the user asks to watch), start
   `.claude/skills/issue-resolve-watch/scripts/watch-issue-resolve.sh` in the **background** with agent
   `notify_on_output` on `^AGENT_LOOP_WAKE_issue_resolve`.
2. Do **not** redirect watcher stdout away from the monitored terminal.
3. On wake: activate the workspace GitHub App, read the issue, **make
   progress toward Done-when** (implement, open/land PRs, update checkboxes,
   reply). If blocked, comment the blocker on the issue — do not go idle.
4. Use `--kickoff` when the agent should start work immediately after arming.
5. Recreate human-authored issues as Addi (close + create) when the user asks
   to “re-open as yourself,” same pattern as PR ownership.
6. **Drain wakes even when chat notify is silent** — see Wake delivery below.

## Wake delivery (chat notify is best-effort)

`notify_on_output` often does **not** start a new agent turn after the turn
that armed the watcher has ended. The sentinel still prints to the watcher
terminal:

```text
AGENT_LOOP_WAKE_issue_resolve {"target":"Owner/repo#N","reason":"...",...}
```

**Agent duties while a watcher is armed:**

- Before ending a turn: skim armed watcher terminal output for unconsumed
  `AGENT_LOOP_WAKE_issue_resolve` lines and process each **now**.
- When the user mentions issue activity, “check watchers”, “process wakes”,
  or similar: read watcher terminals **and** the issue timeline, then drain
  any fired or missed wakes.
- Do not claim “no activity” without checking the watcher terminal; silent
  chat ≠ idle watcher.

**Human mitigations:** ping the agent (“process watcher wakes”) if a comment
or linked PR should have triggered work and nothing happens.

## Launch template

```bash
bash .cursor/skills/issue-resolve-watch/scripts/watch-issue-resolve.sh \
  --interval 30 \
  --activate ~/.config/rosetta/github-app-activate.sh \
  --kickoff \
  Owner/repo#123
```

For a consumer workspace, use
`~/.config/<workspace>/github-app-activate.sh`.

## On wake

1. `eval "$(bash ~/.config/rosetta/github-app-activate.sh)"` by default, or
   use the consumer workspace's `~/.config/<workspace>/github-app-activate.sh`.
2. `gh issue view <n> -R <owner/repo>` — title, body, Done-when, comments.
3. Act by reason:
   - `kickoff` / `human_comment`: plan next step; implement or ask one crisp
     question on the issue if truly blocked.
   - `linked_pr`: triage/merge or fix CI on the linked PR; update issue.
   - `closed`: verify Done-when; if closed prematurely, reopen + comment.
4. When Done-when is satisfied: check boxes, comment the closing PR/SHA,
   `gh issue close`.
5. Brief report in chat.

## Anti-patterns

- Watching an issue with no intent to resolve it.
- Blocking the chat with a foreground poll loop.
- Swallowing wake sentinels by redirecting stdout.
- Leaving a kickoff wake unworked.
- Ending a turn while wakes sit unprocessed in the watcher terminal because
  chat notify did not fire.
