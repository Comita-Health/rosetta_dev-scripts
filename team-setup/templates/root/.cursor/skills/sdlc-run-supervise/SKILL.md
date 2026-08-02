---
name: sdlc-run-supervise
description: >-
  Default operator pattern for sdlc-workflow: detach runs with --supervise
  --detach + --heartbeat, end the agent turn, and check in on heartbeats /
  HUMAN GATE / PRs instead of blocking the chat on long sandbox waits. Use
  whenever starting, resuming, or supervising `run` / `record-merge` waves.
---

# SDLC run — background supervise (default)

**Default, not optional.** Agents MUST NOT hold the main chat turn hostage
with multi-minute `sleep`/poll loops while `sdlc-workflow run` is in flight
(sandbox alone is often 7+ minutes). Detach the engine, report once, yield
the turn, then wake on heartbeats or a short `/loop`.

Live-val roots: rosetta_dev-scripts#38 (detach), #39 (heartbeat).
Design note: `sdlc-workflow/docs/operator-background-supervise.md`.

## Hard rules

1. **Launch with `--supervise --detach`** (engine-native). Do not invent
   `/tmp` bash supervisors unless the engine build predates this flag.
2. **Always pass `--heartbeat`** (default 30 is fine) so stdout +
   `~/.rosetta/sdlc-runs/<runId>/heartbeat.jsonl` grow; supervise mirrors
   them to `monitor.log`.
3. **After launch:** confirm PID alive + first monitor/heartbeat line, give a
   one-line status, then **end the turn**. Do **not** sit in a 30s×N blocking
   poll for the whole sandbox.
4. **Parallel work is allowed** while the run is up.
5. **Ping the human only when needed:** shadow merges, envelope hand-edits,
   real regressions, or wave complete. Routine heartbeats stay in check-ins.

## Launch / resume template

```bash
ENGINE="<workspace>/rosetta_dev-scripts/sdlc-workflow"
RUN_ID="<run-id>"
SPEC="<absolute-path-to-Approved-spec.md>"
TARGET="<absolute-path-to-app-repo>"
CHRONICLE="<absolute-path-to-personal-chronicle>"   # optional

cd "$ENGINE"
bunx tsx src/index.ts run \
  --spec "$SPEC" \
  --repo "$TARGET" \
  --chronicle-repo "$CHRONICLE" \
  --run-id "$RUN_ID" \
  --max-parallel 1 \
  --heartbeat 30 \
  --supervise \
  --detach
```

**Enforcing is the default and is what you want.** Green gates auto-merge and
the loop keeps going; the spec `Draft → Approved` flip was the human gate.
Add `--shadow` only to calibrate a repo the engine has never merged into —
shadow stops at a human gate after *every* wave and needs a merge plus
`record-merge` plus a relaunch per task, so it is three manual steps per task,
not one.

Smoke-check once (do not loop yet):

```bash
RUN="$HOME/.rosetta/sdlc-runs/${RUN_ID}"
ps -p "$(cat "$RUN/supervise.pid")" -o etime=,command=
tail -5 "$RUN/supervise.log"
tail -5 "$RUN/monitor.log"
tail -2 "$RUN/heartbeat.jsonl"
```

Then tell the user: run id, PID, monitor path, and the next human action if any.

## Check-in (wake pattern)

```bash
RUN="$HOME/.rosetta/sdlc-runs/${RUN_ID}"
ps -p "$(cat "$RUN/supervise.pid")" -o etime= || echo DEAD
bunx tsx src/index.ts status --run-id "$RUN_ID" | head -40
tail -20 "$RUN/monitor.log"
tail -15 "$RUN/supervise.log"
gh pr list --search "head:sdlc/${RUN_ID}" --state open \
  --json number,title,url,headRefName
```

| Signal | Action |
|--------|--------|
| Monitor shows `ALL TASKS MERGED` | Close out / mark spec Done |
| Monitor shows `HUMAN GATE (shadow)` | Merge PRs + `record-merge`, then `--supervise --detach` again |
| `supervise.pid` dead, log silent | Relaunch with `--supervise --detach` |
| Monitor shows `stopped` / `failed` | Triage gate / CI |

## After human merge (shadow only)

```bash
bunx tsx src/index.ts record-merge \
  --run-id "$RUN_ID" --sha "<merge-commit>" --task "T-0N" \
  --chronicle-repo "$CHRONICLE"
# Resume supervise (enforce auto-merges; shadow needs this after each merge)
bunx tsx src/index.ts run ... --supervise --detach --shadow
```

## Anti-patterns

- Blocking the chat with `for i in …; do sleep 30; …; done` for an entire
  sandbox/CI wait.
- Harness-only background of `run` without `--detach` (dies with the tool — #38).
- Ad-hoc `/tmp/*-supervise.sh` when engine `--supervise --detach` is available.
- Spamming the user with every heartbeat tick.
