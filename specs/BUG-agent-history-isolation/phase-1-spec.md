---
id: SPEC-BUG-agent-history-isolation-P1
prd: BUG-agent-history-isolation # synthetic id — lightweight bug path, no PRD file
phase: 1
status: Approved # Draft | Approved | Done | Superseded
date: 2026-08-07
owner: Russ Watson
envelope:
  allowedPaths:
    [
      'sdlc-workflow/src/utils/agent-env.ts',
      'sdlc-workflow/src/__tests__/agent-env.test.ts',
      'sdlc-workflow/src/__tests__/agent-runner.repository.test.ts',
      'sdlc-workflow/src/__tests__/cursor-cli.repository.test.ts',
      'sdlc-workflow/README.md',
      'specs/BUG-agent-history-isolation/**',
      'CHANGELOG.md'
    ]
  forbiddenSurfaces: ['ci-config', 'personal-queue-schema']
  maxDiffLines: 300
  budgetK: 120
---

# SPEC-BUG-agent-history-isolation-P1: Engine agent sessions stay out of operator chat history

> Copy of `rosetta_docs/product/BUG-SPEC-TEMPLATE.md` filled for this bug
> (lightweight bug entry into the same spec-run-verify-merge machine).

## Context

**Symptom:** The operator's Cursor chat history is dominated by engine-spawned
task sessions. Every implementation, reviewer, verifier, and remediation
dispatch writes a transcript into the operator's history root, keyed by the
agent's cwd — which for the engine is a per-task run worktree. Measured on one
workspace: **126 engine history buckets holding 214 transcripts** versus **53**
transcripts for the operator's own project. Finding a real conversation means
scrolling past dozens of `…sdlc-runs-<run>-worktrees-T-0N` entries, and the
count grows by one bucket per task per run.

**Repro:** Run any enforce wave (`run --supervise`), then list the history root:

```bash
ls -1 ~/.cursor/projects | grep -c 'sdlc-runs'
```

Each task worktree that hosted a dispatch has its own bucket, with the
transcripts under `<bucket>/agent-transcripts/`.

**Root cause:** The Cursor Agent CLI derives its history root from
`CURSOR_DATA_DIR` (defaulting to `~/.cursor`), then keys a project bucket off
the agent's working directory. `sanitizedAgentEnv()` is a denylist that strips
nested-agent markers but passes the rest of `process.env` through, so engine
dispatches inherit the operator's default data dir and land in the operator's
history. Both dispatch paths are affected: `AgentRunnerRepository` (workspace
-mutating implementation and remediation agents, cwd = task worktree) and
`CursorCliRepository` (reviewer / verifier / decompose completions, cwd = OS
temp dir).

**Why now / blast radius:** Engine-internal only
(`sdlc-workflow/src/utils/agent-env.ts` plus tests and README). Confirmed by
probe that `CURSOR_DATA_DIR` relocates transcripts and that authentication is
unaffected, because credentials resolve from `CURSOR_CONFIG_DIR` /
`~/.cursor/cli-config.json` — a separate root this change does not touch. The
only behavioral loss is that engine transcripts stop appearing in the Cursor
history UI, so resuming a wedged task agent requires the documented
`CURSOR_DATA_DIR=… cursor-agent ls` escape hatch. A single stable directory
(not per-run) keeps that hatch to one command.

## Task T-01: Dispatch engine agents into an isolated history root

- **Story:** S-01
- **Complexity:** S
- **Depends on:** []

Give every engine-spawned agent its own Cursor data dir so its transcripts
never enter the operator's history root.

1. In `sanitizedAgentEnv()`, set `CURSOR_DATA_DIR` on the returned environment
   to the engine's agent-data root. Default it to `~/.rosetta/agent-data`;
   allow an explicit `SDLC_AGENT_DATA_DIR` override for operators who keep
   engine state elsewhere.
2. Set it unconditionally rather than deferring to an inherited
   `CURSOR_DATA_DIR`: an inherited value is the operator's own history root
   (that is the bug), so honoring it would leave the default path broken. The
   documented override is `SDLC_AGENT_DATA_DIR`'s explicit opt-in, not ambient
   inheritance.
3. Leave `CURSOR_CONFIG_DIR` and every other credential-bearing variable
   untouched, so dispatches stay authenticated against the operator's logged-in
   CLI session.
4. Both dispatch paths must be covered, since both call `sanitizedAgentEnv()`:
   the workspace-mutating runner and the completion transport.
5. Document the isolation and the resume escape hatch in
   `sdlc-workflow/README.md`: where engine transcripts live, and that
   `CURSOR_DATA_DIR=~/.rosetta/agent-data cursor-agent ls` is how an operator
   inspects or resumes an engine session.

Do not change which binary or model a dispatch uses, the nested-agent denylist
entries, timeouts, or any gate behavior.

### Acceptance criteria

- [x] test: `sanitizedAgentEnv()` returns `CURSOR_DATA_DIR` pointing at the
      engine agent-data root when the variable is absent from the base env
- [x] test: `sanitizedAgentEnv()` overrides an inherited `CURSOR_DATA_DIR`
      (an operator's own history root must not be reused for dispatches)
- [x] test: `SDLC_AGENT_DATA_DIR` takes precedence over the built-in default
- [x] test: `sanitizedAgentEnv()` leaves `CURSOR_CONFIG_DIR` and the existing
      passthrough variables (`CURSOR_AGENT_BIN`, `CURSOR_MODEL`) unchanged, and
      still strips every `NESTED_AGENT_ENV_KEYS` entry
- [x] test: the workspace-mutating runner spawns with `CURSOR_DATA_DIR` set to
      the engine root
- [x] test: the completion transport spawns with `CURSOR_DATA_DIR` set to the
      engine root
- [ ] docs: `sdlc-workflow/README.md` states where engine agent transcripts
      live and gives the `CURSOR_DATA_DIR=… cursor-agent ls` resume command
- [ ] agent: diff is confined to the dispatch environment and its tests — no
      change to gate order, prompts, timeouts, or model selection
