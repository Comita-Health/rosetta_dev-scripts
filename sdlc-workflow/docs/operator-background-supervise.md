# Operator default: background supervise + heartbeats

`sdlc-workflow run` is often wall-clock heavy (sandbox deploy alone is
commonly several minutes per task). Agents and humans must **not** treat a
long-running `run` as a reason to freeze the chat session.

## Default pattern

1. Detach with **OS `nohup`** (not IDE/agent harness backgrounding) — see
   live-val #38 / #43 F2.
2. Pass **`--heartbeat`** (default 30s) — #39 writes `[heartbeat] {json}` to
   stdout and appends `<runsDir>/<runId>/heartbeat.jsonl`.
3. Confirm PID + first heartbeat, then **yield** the agent turn.
4. Re-enter on a short interval (`/loop` 2–5m) or when log/heartbeat signals
   change; only escalate to the human for merges, real regressions, or
   closeout.

Team-setup encodes this as the **`sdlc-run-supervise`** skill (Claude +
Cursor) and the `/sdlc-run` command. Progress scorecards stay in
`sdlc-prd-progress` (`/sdlc-status`).

## Why

| Anti-pattern                              | Failure                                           |
| ----------------------------------------- | ------------------------------------------------- |
| Harness background of `run`               | Silent death ~35s (#38)                           |
| Blocking 30s poll loops in one agent turn | Chat looks "stuck"; humans interrupt product work |
| No heartbeat                              | Operators cannot tell impl vs sandbox vs dead     |

## Minimal commands

```bash
nohup bunx tsx src/index.ts run \
  --spec "$SPEC" --repo "$TARGET" --run-id "$RUN_ID" \
  --shadow --heartbeat 30 \
  > "/tmp/${RUN_ID}.log" 2>&1 &
echo $! > "/tmp/${RUN_ID}.pid"

# later
tail -5 ~/.rosetta/sdlc-runs/${RUN_ID}/heartbeat.jsonl
bunx tsx src/index.ts status --run-id "$RUN_ID" | head -40
```

After a human merge in shadow mode: `record-merge --task T-xx --sha …`, then
the same `nohup … run …` to unlock dependents from the post-merge tip
(`docs/merged-tip-baseRef.md`).

## Related

- Umbrella live-val: [rosetta_dev-scripts#43](https://github.com/Rosetta-Foundation/rosetta_dev-scripts/issues/43)
- Heartbeat / tip engine: #39, #42, #44
