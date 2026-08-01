---
name: sdlc-run-supervise
description: >-
  Default operator pattern for sdlc-workflow: detach runs with OS nohup +
  --heartbeat, end the agent turn, and check in on heartbeats / HUMAN GATE /
  PRs instead of blocking the chat on long sandbox waits. Use whenever
  starting, resuming, or supervising `run` / `record-merge` / shadow waves.
---

# SDLC run — background supervise (default)

**Default, not optional.** Agents MUST NOT hold the main chat turn hostage
with multi-minute `sleep`/poll loops while `sdlc-workflow run` is in flight
(sandbox alone is often 7+ minutes). Detach the engine, report once, yield
the turn, then wake on heartbeats or a short `/loop`.

Live-val roots: rosetta_dev-scripts#38 (nohup), #39 (heartbeat), #43 (F2/F3).
Design note: `sdlc-workflow/docs/operator-background-supervise.md`.

## Hard rules

1. **Spawn with OS `nohup`**, never IDE/agent harness backgrounding alone (#38).
2. **Always pass `--heartbeat`** (default 30 is fine) so stdout +
   `~/.rosetta/sdlc-runs/<runId>/heartbeat.jsonl` grow.
3. **After launch/resume:** confirm PID alive + first heartbeat line, give a
   one-line status, then **end the turn** (or arm a `/loop` / watcher). Do
   **not** sit in a 30s×N blocking poll for the whole sandbox.
4. **Parallel work is allowed** — product docs, PRD acceptance, other repos —
   while the run is up. Treat "Running" as _supervising in background_.
5. **Ping the human only when needed:** merge a task PR, hand-edit envelope,
   real regression, or wave complete. Routine heartbeats stay in the agent
   check-in, not as chat spam.

## Launch / resume template

```bash
ENGINE="<workspace>/rosetta_dev-scripts/sdlc-workflow"
RUN_ID="<run-id>"
SPEC="<absolute-path-to-Approved-spec.md>"
TARGET="<absolute-path-to-app-repo>"
CHRONICLE="<absolute-path-to-personal-chronicle>"   # optional

cd "$ENGINE"
nohup bunx tsx src/index.ts run \
  --spec "$SPEC" \
  --repo "$TARGET" \
  --chronicle-repo "$CHRONICLE" \
  --run-id "$RUN_ID" \
  --shadow \
  --max-parallel 1 \
  --heartbeat 30 \
  > "/tmp/${RUN_ID}.log" 2>&1 &
echo $! > "/tmp/${RUN_ID}.pid"
```

Smoke-check once (do not loop yet):

```bash
ps -p "$(cat /tmp/${RUN_ID}.pid)" -o etime=,command=
tail -5 "/tmp/${RUN_ID}.log"
tail -2 ~/.rosetta/sdlc-runs/${RUN_ID}/heartbeat.jsonl
```

Then tell the user: run id, PID, that you'll check in on heartbeats, and the
next human action if any (none yet).

## Check-in (wake pattern)

Prefer Cursor `/loop` (e.g. every 2–5m) or a watcher on log/heartbeat
sentinels. On each wake, run a **cheap** pulse — not a long sleep inside the
tool call:

```bash
PID=$(cat /tmp/${RUN_ID}.pid)
ps -p "$PID" -o etime= || echo DEAD
bunx tsx src/index.ts status --run-id "$RUN_ID" | head -40
tail -15 "/tmp/${RUN_ID}.log"
tail -3 ~/.rosetta/sdlc-runs/${RUN_ID}/heartbeat.jsonl
gh pr list --search "head:sdlc/${RUN_ID}" --state open \
  --json number,title,url,headRefName
```

Escalate / message the human when:

| Signal                                           | Action                            |
| ------------------------------------------------ | --------------------------------- |
| Log shows `[HUMAN GATE]` and process exited      | Summarize gates; ask/merge PR     |
| Open `sdlc/<runId>/T-xx` PR, gates green         | Propose merge + `record-merge`    |
| Process dead, log silent                         | #38 — relaunch with `nohup`       |
| Dirty tip, no commit >15–20m, no engine salvage  | #41 regression                    |
| Envelope LOC ≫ PR additions after deps merged    | F1/#42 regression                 |
| `status` → `RUN_NOT_FOUND` with worktree present | Expected until #37; note duration |

## After human merge (shadow)

```bash
bunx tsx src/index.ts record-merge \
  --run-id "$RUN_ID" --sha "<merge-commit>" --task "T-0N" \
  --chronicle-repo "$CHRONICLE"
# Then the same nohup run … resume (step cache + unlocked dependents)
```

Do **not** manually fast-forward worktrees to "fix" tip tracking unless the
engine fails — tip branching is the engine's job after #44.

## Anti-patterns

- Blocking the chat with `for i in …; do sleep 30; …; done` for an entire
  sandbox/CI wait.
- Harness-only background of `run` (dies ~35s — #38).
- Spamming the user with every heartbeat tick.
- Assuming one approval unlocks all tasks (F6) — each merge + `record-merge`
  unlocks only its dependents.

## Related skills / commands

- Scorecard / portfolio: `sdlc-prd-progress` (`/sdlc-status`, `/prd-portfolio`)
- Slash kickoff reminder: `/sdlc-run`
