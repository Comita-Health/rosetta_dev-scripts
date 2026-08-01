# sdlc-workflow

PRD-0011 (Full-Loop SDLC Automation):

- **Phase 1** (`decompose`, [SPEC-PRD-0011-P1](../specs/PRD-0011/phase-1-spec.md)):
  decompose a PRD into product stories, synthesize an
  [ADR-0008](https://github.com/Rosetta-Foundation/rosetta_docs/blob/main/architecture/ADR-0008-implementation-spec-format.md)
  implementation spec with a blast-radius envelope, write it to the target
  repo as `Draft`, and stop at the human gate.
- **Phase 2** (`run`, [SPEC-PRD-0011-P2](../specs/PRD-0011/phase-2-spec.md),
  done): execute one ready task from an Approved spec in an isolated
  worktree, run machine gates in **shadow mode** (verdicts recorded, never
  enforced), and halt — human approval is the only advance mechanism.
- **Phase 3** ([SPEC-PRD-0011-P3](../specs/PRD-0011/phase-3-spec.md), in
  progress): parallel fan-out across ready tasks, real PR lifecycle with a
  bounded CI fix cycle, gate enforcement with auto-merge on green,
  post-merge sandbox deploy + PRD-0007 digest with veto-triggered revert.
  Landed so far: the T-01 dependency-ordered task pool.

## Usage

```bash
cd sdlc-workflow
bun install

# Phase 1: decompose a PRD and write the Draft spec into a target repo
bun run dev -- decompose --prd PRD-0011 --repo ../../rosetta_chronicle

# Options
#   --docs-dir   PRD location (default: ../rosetta_docs/product)
#   --phase      rollout phase to specify (default: 1)
#   --budget-k   token budget in thousands, recorded in the envelope (default: 200)

# Execute all ready tasks from an Approved spec (parallel worktrees)
bun run dev -- run --spec ../specs/PRD-0011/phase-3-spec.md --repo .. \
  --chronicle-repo ../../rosetta_chronicle_roustalski

# Options
#   --run-id          stable run identifier; branches are sdlc/<run-id>/<task-id>
#                     (default: <spec-file>-<date>)
#   --runs-dir        run state + worktrees location (default: ~/.rosetta/sdlc-runs)
#   --chronicle-repo  personal Chronicle ledger repo; enables the T-07 queue
#                     digest and T-08 artifact commits (skipped when absent)
#   --max-parallel    concurrent implementation agents per wave (default: 3)

# Record a human-approved merge in the run's Chronicle artifact (T-08);
# --task marks that task merged, which unblocks its dependents (P3 T-01)
bun run dev -- record-merge --run-id <run-id> --sha <merged-sha> \
  --task T-01 --chronicle-repo ../../rosetta_chronicle_roustalski

# Inspect a run: task results, cached step graph, verdicts, exceptions (T-09)
bun run dev -- status --run-id <run-id>
```

`decompose` hard-stops after writing the Draft spec. Approval is a
`status: Draft → Approved` flip in a dedicated commit (ADR-0008) —
`run` refuses anything but an Approved spec, records the refusal as a
blocked verdict, and executes at most one task per invocation. The envelope
gate evaluates the task branch diff against the spec's blast-radius envelope
(forbidden-surface labels resolve via `<repo>/.sdlc/surfaces.json`); in this
phase every gate verdict is shadow-mode only.

## Repo-owned `.sdlc/` contracts

The engine never owns deployment or test mechanics — the target repo
declares them:

```jsonc
// .sdlc/environments.json — only the "sandbox" entry is ever read (S-04:
// no code path can reach any other environment). Commands receive the
// deployed SHA as SDLC_SANDBOX_SHA; health output must echo it.
{
  "sandbox": {
    "deployCommand": "git push origin HEAD:build-env/dev && gh run watch --exit-status",
    "healthCommand": "curl -fsS https://app.dev.example.com/health",
    "timeoutMinutes": 45 // default
  }
}

// .sdlc/verification.json — scripted check for test-tier criteria.
{ "testCommand": "bun test" }

// .sdlc/surfaces.json — forbidden-surface label → path globs.
{ "migrations": ["**/migrations/**"] }
```

A missing contract never fails the run: the corresponding gate records
itself `blocked` (sandbox) or degrades the criteria to `human-required`
(verification), keeping the shadow-mode phase verdict honest.

## Resumable step graph (T-09)

Every pipeline step — implementation, each gate, the digest post, the
Chronicle commit — is cached in run state under a key derived from a
SHA-256 **inputs digest** rooted at `{task content, base SHA}` and chained
through the worktree head SHA. Kill the run at any boundary and rerun the
same command: cache hits are replayed (agents are not re-invoked, the
sandbox is not redeployed, digests are not re-posted), and only steps whose
inputs changed or never completed execute. Editing a task's spec content
changes its digest and invalidates exactly that task's chain. `status`
shows what is cached versus what would re-execute.

This repo dogfoods the pipeline against itself:
[`SPEC-LIVE-VALIDATION-P1`](../specs/PRD-0011/live-validation-spec.md) is a
one-task harness spec, and the root `.sdlc/` contracts declare a local
process sandbox (`scripts/sandbox-deploy.sh` stages the built CLI keyed by
`SDLC_SANDBOX_SHA`; `scripts/sandbox-health.sh` echoes it back).

## Chronicle integration (T-07 / T-08)

With `--chronicle-repo` set, the phase boundary:

- commits versioned JSON artifacts (`sdlc.spec.v1`, `sdlc.task-result.v1`,
  `sdlc.verdict.v1`, `sdlc.exceptions.v1`, `sdlc.digest.v1`,
  `sdlc.merge.v1`) under `chronicles/sdlc/<run-id>/`, and
- posts one informational digest item to the PRD-0007 personal queue
  (`chronicles/queue.md`, Inbox) — no veto or revert semantics this phase.

Ledger commits follow ADR-0007: `chronicle(sdlc): ...` /
`chronicle(queue): ...` with `Chronicle-Window:` and `Generated-By:`
trailers. Verdict artifacts carry gate identity, inputs digest, outcome,
and resolvable evidence refs, and read back through
`GatePolicyQueryService` so future gate policy can learn from track record.

## Environment

Inference runs over one of three transports, selected automatically:
`ANTHROPIC_API_KEY` present → Anthropic API (PRD-0011 §5 default); else
`OPENAI_API_KEY` present → OpenAI Responses API; otherwise the operator's
logged-in Cursor Agent CLI session (`cursor-agent -p`, the same
operator-auth pattern as `gh`).

| Variable                 | Required | Purpose                                                        |
| ------------------------ | -------- | -------------------------------------------------------------- |
| `ANTHROPIC_API_KEY`      | no\*     | Anthropic API model calls (ADR-0003 / PRD-0011 §5)             |
| `ANTHROPIC_MODEL`        | no       | Override the Anthropic default model (`claude-sonnet-4-5`)     |
| `OPENAI_API_KEY`         | no\*     | OpenAI Responses API model calls                               |
| `OPENAI_MODEL`           | no       | Override the OpenAI default model (`gpt-5.6`)                  |
| `OPENAI_BASE_URL`        | no       | OpenAI-compatible gateway base URL (default: `api.openai.com`) |
| `SDLC_INFERENCE_BACKEND` | no       | Force a backend: `anthropic`, `openai`, or `cursor-cli`        |
| `CURSOR_AGENT_BIN`       | no       | Cursor Agent CLI binary (default: `cursor-agent`)              |
| `CURSOR_MODEL`           | no       | Model passed to the Cursor Agent CLI                           |

\* With neither key set, a logged-in `cursor-agent` session is required.

## Architecture

Handler / Service / Repository with InversifyJS (workspace rule):

- `handlers/workflow.handler.ts` — Phase 1 pipeline, prints the gate.
- `handlers/run.handler.ts` — pooled task loop: parallel executor wave +
  per-task shadow gates + digest/Chronicle steps, all through the T-09
  step cache.
- `services/decompose.service.ts` — PRD → `ProductStory[]` (right-sizing prompt).
- `services/spec-synthesis.service.ts` — stories → tasks + envelope → validated
  ADR-0008 Markdown.
- `services/executor.service.ts` — approved-spec intake and the P3 T-01
  task pool: merged-dependency eligibility, bounded parallel agent
  fan-out, one worktree per task.
- `services/envelope-gate.service.ts` — diff vs blast-radius envelope,
  shadow-mode verdict (T-02).
- `services/sandbox-deploy.service.ts` — task-branch build → sandbox via the
  repo-owned contract; idempotent per SHA, health must report the deployed
  SHA, structurally unable to reach any other environment (T-03).
- `services/verification.service.ts` — tiered acceptance-criteria runner:
  test-tier via the repo's scripted check, agent-tier via an independent
  verifier agent driving the sandbox, manual-tier forces human-required;
  every criterion verdict references its evidence artifact (T-04).
- `services/reviewer-gate.service.ts` — independent reviewer agent over the
  diff + task + envelope only; concur/disagree with cited reasons and the
  full transcript attached (T-05).
- `services/aggregator.service.ts` — combines ci / verification / reviewer /
  envelope into one phase verdict and derives exception-ledger entries
  (reviewer disagreement, third CI fix attempt, envelope breach, budget
  exhaustion) (T-06).
- `services/ci-gate.service.ts` — the real CI gate: GitHub check runs for
  the task branch head SHA via the operator's `gh` session; honest
  `blocked` when the branch is not pushed (shadow mode).
- `services/digest.service.ts` — phase-boundary digest to the PRD-0007
  personal queue; append-only, no veto path (T-07).
- `services/chronicle-commit.service.ts` — versioned run artifacts +
  merged-SHA recording, committed per ADR-0007 (T-08).
- `services/gate-policy-query.service.ts` — reads verdict artifacts back
  for gate-policy consumption (T-08).
- `repositories/` — PRD parsing (`prd`), model transports (`anthropic`,
  `openai`, `cursor-cli` behind the shared `IModelRepository` contract in
  `model`),
  schema-constrained inference with one retry (`inference`), spec file writes
  (`spec-file`), spec reads (`spec-doc`), git worktrees/diffs (`git`),
  workspace-mutating agent runs (`agent-runner`), resumable run state with
  the step graph (`run-state`), protected-surface map (`surface-map`),
  `.sdlc/` contracts (`contract`), contract command execution
  (`shell-command`), evidence artifacts (`evidence`), PRD-0007 queue
  appends (`queue`), Chronicle ledger artifacts + ADR-0007 commits
  (`chronicle-artifact`), GitHub check-run status (`ci-status`).
- `utils/` — pure functions: PRD parser, JSON-schema validator, spec renderer,
  ADR-0008 format validator, spec parser (round-trip of the renderer), glob
  matcher, criterion-tier parser, inputs digest (`digest`), and the
  implementation / reviewer / verifier agent prompt builders.

## Testing

```bash
bun run test:coverage   # jest via @swc/jest; 90% global thresholds
```

Repo CI runs this suite on every PR (`.github/workflows/ci.yml`), alongside
`team-setup`.
