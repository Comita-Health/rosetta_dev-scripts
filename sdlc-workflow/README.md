# sdlc-workflow

PRD-0011 (Full-Loop SDLC Automation):

- **Phase 1** (`decompose`, [SPEC-PRD-0011-P1](../specs/PRD-0011/phase-1-spec.md)):
  decompose a PRD into product stories, synthesize an
  [ADR-0008](https://github.com/Rosetta-Foundation/rosetta_docs/blob/main/architecture/ADR-0008-implementation-spec-format.md)
  implementation spec with a blast-radius envelope, write it to the target
  repo as `Draft`, and stop at the human gate.
- **Phase 2** (`run`, [SPEC-PRD-0011-P2](../specs/PRD-0011/phase-2-spec.md),
  in progress): execute one ready task from an Approved spec in an isolated
  worktree, run machine gates in **shadow mode** (verdicts recorded, never
  enforced), and halt — human approval is the only advance mechanism.

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

# Phase 2: execute one ready task from an Approved spec
bun run dev -- run --spec ../specs/PRD-0011/phase-2-spec.md --repo ..

# Options
#   --run-id     stable run identifier; branches are sdlc/<run-id>/<task-id>
#                (default: <spec-file>-<date>)
#   --runs-dir   run state + worktrees location (default: ~/.rosetta/sdlc-runs)
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
- `handlers/run.handler.ts` — Phase 2 single-task loop: executor + shadow
  gates + persistence.
- `services/decompose.service.ts` — PRD → `ProductStory[]` (right-sizing prompt).
- `services/spec-synthesis.service.ts` — stories → tasks + envelope → validated
  ADR-0008 Markdown.
- `services/executor.service.ts` — approved-spec intake, single ready-task
  selection, worktree + implementation-agent execution (T-01).
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
- `repositories/` — PRD parsing (`prd`), model transports (`anthropic`,
  `openai`, `cursor-cli` behind the shared `IModelRepository` contract in
  `model`),
  schema-constrained inference with one retry (`inference`), spec file writes
  (`spec-file`), spec reads (`spec-doc`), git worktrees/diffs (`git`),
  workspace-mutating agent runs (`agent-runner`), resumable run state
  (`run-state`), protected-surface map (`surface-map`), `.sdlc/` contracts
  (`contract`), contract command execution (`shell-command`), evidence
  artifacts (`evidence`).
- `utils/` — pure functions: PRD parser, JSON-schema validator, spec renderer,
  ADR-0008 format validator, spec parser (round-trip of the renderer), glob
  matcher, criterion-tier parser, and the implementation / reviewer /
  verifier agent prompt builders.

## Testing

```bash
bun run test:coverage   # jest via @swc/jest; 90% global thresholds
```

> Note: repo CI currently runs `team-setup` tests only; wiring this package
> into `ci.yml` and the root workspace list is outside SPEC-PRD-0011-P1's
> envelope (`ci-config` is a forbidden surface) and tracked as a follow-up.
