# Operator background supervise

Live-val roots: [rosetta_dev-scripts#38](https://github.com/Rosetta-Foundation/rosetta_dev-scripts/issues/38) (nohup/detach), [#39](https://github.com/Rosetta-Foundation/rosetta_dev-scripts/issues/39) (heartbeat), Phase 0b enforce resume loop.

## Why

Each `run` invocation processes **one dependency wave**. After an enforce auto-merge, dependents need another `run` (resume). Agent/IDE shells also kill foreground children when the tool call ends — so long sandbox/CI waits must not block the chat, and the engine must outlive the parent shell.

## CLI

```bash
# Optional: activate Addi so ad-hoc gh in this shell is App-authored. The run
# does not depend on it — the engine mints and refreshes its own token per
# call. Do not treat an activated shell as the run's credential: the token it
# exports expires after 60 minutes, long before a detached run finishes.
eval "$(bash ~/.config/comita/github-app-activate.sh)"   # or ~/.config/rosetta/…

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

- **Enforce** (`--shadow` omitted): green gates auto-merge; `--supervise` resumes until all `mergedSha`s are set. A red phase, or a green phase whose `gh pr merge` failed (e.g. conflicts), **fails the supervise loop** (exit 1) — it does not spin another empty wave. Before recording merge-blocked on a red phase, the engine asks GitHub whether the task PR already landed (GHA Addi merge-on-approve / human merge); if MERGED, it records `mergedSha` and continues so dependents and `queue-run` are not stuck waiting for a manual `record-merge` (#79). After you fix gates or conflicts, resume: a green-phase unmerged task is re-selected so merge can retry. Stale `merge-blocked` exceptions from an earlier red phase do not block that resume. `record-merge --task` (and any engine merge) zeros `mergeBlockedRetries`. After each successful merge the engine runs `git fetch origin` so the next wave’s tip SHA exists locally (no manual fetch between waves).
- **Shadow**: after a wave with completed-but-unmerged tasks, supervise **stops** at the human gate. Merge + `record-merge`, then re-invoke with `--supervise` (and `--detach` if backgrounding).

**Merge-on-approve orgs:** Approving an sdlc task PR while engine verification is still red will land the PR out-of-band. Prefer waiting for green gates before Approve; if you Approve early, the engine reconciles the merge (above) instead of stalling the queue.

Gate log lines are labeled `[enforce]` or `[shadow]` to match the mode. When supervise exits, `monitor.log` gets an `[hb-watch] stopped` line (the watch is not a healer — it only mirrors heartbeats while the loop runs).

## Spec provenance (enforce)

Enforce intake loads the Approved spec from `origin/<defaultBranch>`, not from
the operator working tree. A stale local checkout of the spec file no longer
blocks the next supervise wave after a merge updates the blob on origin.

Continuity lives in the per-workspace TypeScript daemon (`sdlc-workflow daemon`
/ `ContinuityService`). The bash StartInterval job
(`scripts/sdlc-continuity-daemon.sh` + `install-continuity-daemon.sh` →
`com.rosetta.sdlc-daemon`) is **retired** (SPEC-PRD-0020-P2 T-05): those
scripts are fail-loud stubs that exit non-zero with migration guidance.
Do **not** schedule them. Cut over with:

```bash
cd sdlc-workflow
bun run build
node dist/index.js daemon install --workspace <workspace-root>
# install unloads/removes com.rosetta.sdlc-daemon before loading KeepAlive

# Expect the per-workspace label (sdlc.workflow.daemon.<id>) with KeepAlive,
# and no active com.rosetta.sdlc-daemon job:
launchctl print "gui/$(id -u)" | grep -E 'sdlc.workflow.daemon|com.rosetta.sdlc-daemon'
```

The KeepAlive daemon tick relaunches unfinished runs with a dead
`supervise.pid` when `launch.json` is usable; abandoned idle runs get one
wake and are not relaunched; needs-human blocker-close commits a `closed`
wake on the shared inbox and resumes only through the registered
`engine-resume` wake action. Session-mortal `deploy-verify-watch` and
`issue-resolve-watch` bash loops remain until Phase 3.

Enforce intake already reads the Approved spec from `origin/<defaultBranch>`,
so operators should not rely on a relaunch-time working-tree spec sync.

Product-task diffs must not edit `specs/**` — the envelope gate hard-breaches
those paths even when listed in `allowedPaths`. Checkbox / `status: Done`
closeout stays a separate docs PR after the phase.

## Agent skill

Workspace skill `sdlc-run-supervise` should prefer `--supervise --detach` over ad-hoc `/tmp` bash supervisors.
