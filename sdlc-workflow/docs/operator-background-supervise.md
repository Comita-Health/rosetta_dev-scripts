# Operator background supervise

Live-val roots: [rosetta_dev-scripts#38](https://github.com/Rosetta-Foundation/rosetta_dev-scripts/issues/38) (nohup/detach), [#39](https://github.com/Rosetta-Foundation/rosetta_dev-scripts/issues/39) (heartbeat), Comita Phase 0b enforce resume loop.

## Why

Each `run` invocation processes **one dependency wave**. After an enforce auto-merge, dependents need another `run` (resume). Agent/IDE shells also kill foreground children when the tool call ends — so long sandbox/CI waits must not block the chat, and the engine must outlive the parent shell.

## CLI

```bash
# Recommended operator / agent launch (likely future default for --supervise):
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

| Flag               | Meaning                                                                                                                                               |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--supervise`      | Loop waves until all tasks merge (enforce), or stop at shadow human gate / failure. Starts a live heartbeat → `monitor.log` mirror.                   |
| `--detach`         | Spawn a detached child (`child_process` `detached: true` + file stdio) and exit. Child always runs with `--supervise`. Survives agent shell teardown. |
| `--monitor <path>` | Override monitor log path (default `<runsDir>/<runId>/monitor.log`).                                                                                  |
| `--max-waves <n>`  | Cap wave iterations (default 20).                                                                                                                     |

Without `--supervise`, behaviour is unchanged: single wave, then exit.

## Artifacts

Under `~/.rosetta/sdlc-runs/<runId>/`:

| File                | Role                                              |
| ------------------- | ------------------------------------------------- |
| `supervise.pid`     | Supervisor (or detached child) PID                |
| `supervise.log`     | Detached child stdout/stderr                      |
| `monitor.log`       | Live heartbeat feed + supervise notes (`tail -f`) |
| `monitor.log.count` | Heartbeat line counter                            |
| `heartbeat.jsonl`   | Native engine heartbeat (#39)                     |
| `state.json`        | Run state / step cache                            |

## Shadow vs enforce

- **Enforce** (`--shadow` omitted): green gates auto-merge; `--supervise` resumes until all `mergedSha`s are set. A red phase, or a green phase whose `gh pr merge` failed (e.g. conflicts), **fails the supervise loop** (exit 1) — it does not spin another empty wave. After you fix gates or conflicts, resume: a green-phase unmerged task is re-selected so merge can retry. Stale `merge-blocked` exceptions from an earlier red phase do not block that resume.
- **Shadow**: after a wave with completed-but-unmerged tasks, supervise **stops** at the human gate. Merge + `record-merge`, then re-invoke with `--supervise` (and `--detach` if backgrounding).

Gate log lines are labeled `[enforce]` or `[shadow]` to match the mode. When supervise exits, `monitor.log` gets an `[hb-watch] stopped` line (the watch is not a healer — it only mirrors heartbeats while the loop runs).

## Agent skill

Workspace skill `sdlc-run-supervise` should prefer `--supervise --detach` over ad-hoc `/tmp` bash supervisors.
