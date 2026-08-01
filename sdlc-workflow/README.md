# sdlc-workflow

PRD-0011 (Full-Loop SDLC Automation) — **rollout Phase 1**: decompose a PRD
into product stories, synthesize an
[ADR-0008](https://github.com/Rosetta-Foundation/rosetta_docs/blob/main/architecture/ADR-0008-implementation-spec-format.md)
implementation spec with a blast-radius envelope, write it to the target repo
as `Draft`, and stop at the human gate. Built against
[SPEC-PRD-0011-P1](../specs/PRD-0011/phase-1-spec.md).

## Usage

```bash
cd sdlc-workflow
bun install

# Decompose a PRD and write the Draft spec into a target repo
bun run dev -- decompose --prd PRD-0011 --repo ../../rosetta_chronicle

# Options
#   --docs-dir   PRD location (default: ../rosetta_docs/product)
#   --phase      rollout phase to specify (default: 1)
#   --budget-k   token budget in thousands, recorded in the envelope (default: 200)
```

The command hard-stops after writing the Draft spec. Approval is a
`status: Draft → Approved` flip in a dedicated commit (ADR-0008) —
implementation begins only against an Approved spec.

## Environment

Inference runs over one of two transports, selected automatically:
`ANTHROPIC_API_KEY` present → Anthropic API (PRD-0011 §5 default); otherwise
the operator's logged-in Cursor Agent CLI session (`cursor-agent -p`, the
same operator-auth pattern as `gh`).

| Variable                 | Required | Purpose                                                        |
| ------------------------ | -------- | -------------------------------------------------------------- |
| `ANTHROPIC_API_KEY`      | no\*     | Anthropic API model calls (ADR-0003 / PRD-0011 §5)             |
| `ANTHROPIC_MODEL`        | no       | Override the API backend's default model (`claude-sonnet-4-5`) |
| `SDLC_INFERENCE_BACKEND` | no       | Force a backend: `anthropic` or `cursor-cli`                   |
| `CURSOR_AGENT_BIN`       | no       | Cursor Agent CLI binary (default: `cursor-agent`)              |
| `CURSOR_MODEL`           | no       | Model passed to the Cursor Agent CLI                           |

\* Without it, a logged-in `cursor-agent` session is required instead.

## Architecture

Handler / Service / Repository with InversifyJS (workspace rule):

- `handlers/workflow.handler.ts` — orchestrates the pipeline, prints the gate.
- `services/decompose.service.ts` — PRD → `ProductStory[]` (right-sizing prompt).
- `services/spec-synthesis.service.ts` — stories → tasks + envelope → validated
  ADR-0008 Markdown.
- `repositories/` — PRD parsing (`prd`), model transports (`anthropic`,
  `cursor-cli` behind the shared `IModelRepository` contract in `model`),
  schema-constrained inference with one retry (`inference`), spec file writes
  (`spec-file`).
- `utils/` — pure functions: PRD parser, JSON-schema validator, spec renderer,
  ADR-0008 format validator.

## Testing

```bash
bun run test:coverage   # jest via @swc/jest; 90% global thresholds
```

> Note: repo CI currently runs `team-setup` tests only; wiring this package
> into `ci.yml` and the root workspace list is outside SPEC-PRD-0011-P1's
> envelope (`ci-config` is a forbidden surface) and tracked as a follow-up.
