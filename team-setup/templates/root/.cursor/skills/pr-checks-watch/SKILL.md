---
name: pr-checks-watch
description: >-
  Background-watch open PRs for GitHub check failures, then wake the agent
  to read logs, fix, and push. Use after drop --finish, after pushing to an
  agent PR, or when the user asks to watch CI / PR checks.
---

# PR checks watch (CI failures)

**Drop `--finish` does not wait on CI.** Arm this watcher so a red check
wakes the agent without a chat nudge. Pair with `pr-approve-watch`
(Approve / Request changes) — green checks are not permission to merge.

## What we watch for

| Reason            | Meaning                                              |
| ----------------- | ---------------------------------------------------- |
| `kickoff`         | `--kickoff` at arm time — inspect current rollup now |
| `checks_failed`   | Head SHA has a completed failing check               |
| `checks_success`  | Head SHA reached a terminal all-green rollup         |
| `pr_merged`       | PR merged (stop watching that target)                |
| `pr_closed`       | PR closed without merge (stop watching that target)  |

Wake once per head SHA per terminal outcome. Pending checks do not wake
except `kickoff`.

## Hard rules

1. After `drop --finish` / `gh pr create` / a push that starts CI (or when
   the user asks to watch checks), start
   `.cursor/skills/pr-checks-watch/scripts/watch-pr-checks.sh` in the
   **background** with agent `notify_on_output` on `^AGENT_LOOP_WAKE_pr_checks`.
2. Do **not** redirect watcher stdout away from the monitored terminal.
3. Do **not** block the chat with a foreground `sleep` / `gh pr checks --watch`
   loop. That is this watcher's job.
4. On `checks_failed`: activate Addi, `gh run view --log-failed` (or the
   check annotation), fix in the drop worktree, commit `-s`, push. The
   watcher re-fires on the new SHA if it goes red again.
5. Repeat up to **3** fix iterations per SHA lineage. After 3, comment the
   failure on the PR and flag the human — do not loop silently.
6. On `checks_success`: brief note only. Do **not** merge. Approve stays
   the proceed signal (`pr-approve-watch` / GHA merge-on-approve).
7. **Drain wakes even when chat notify is silent** — see Wake delivery.

## Wake delivery (chat notify is best-effort)

```text
AGENT_LOOP_WAKE_pr_checks {"reason":"checks_failed",...}
```

**Agent duties while a watcher is armed:**

- Before ending a turn: skim the watcher terminal for unconsumed
  `AGENT_LOOP_WAKE_pr_checks` lines and process each **now**.
- When the user says “CI failed”, “check watchers”, or “process wakes”:
  drain the terminal **and** `gh pr checks`.
- Silent chat ≠ idle watcher.

## Launch template

```bash
bash .cursor/skills/pr-checks-watch/scripts/watch-pr-checks.sh \
  --interval 30 \
  --activate ~/.config/comita/github-app-activate.sh \
  --kickoff \
  Comita-Health/comita_admissions#594
```

Claude Code: the same script under
`.claude/skills/pr-checks-watch/scripts/watch-pr-checks.sh`.

## On wake — `checks_failed`

1. Activate the workspace GitHub App.
2. Read failed jobs / annotations for the wake SHA.
3. Fix on the PR branch in the drop worktree (not the primary checkout).
4. Commit with DCO (`git commit -s`); push as Addi.
5. Report what failed and the fix SHA. Keep watching.

## On wake — `kickoff`

If the rollup is already red, treat as `checks_failed`. If pending, wait.
If green, do not ping the human to smoke.

## Anti-patterns

- Blocking the chat on `gh pr checks --watch` / a 15-minute poll loop.
- Swallowing wake sentinels by redirecting stdout.
- Merging on `checks_success`.
- Ignoring a red check because deploy-verify is still in flight.
- Ending a turn while `checks_failed` sits in the watcher terminal.
