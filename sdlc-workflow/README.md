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

| Variable            | Required | Purpose                                          |
| ------------------- | -------- | ------------------------------------------------ |
| `ANTHROPIC_API_KEY` | yes      | Model calls (ADR-0003 / PRD-0011 §5)             |
| `ANTHROPIC_MODEL`   | no       | Override the default model (`claude-sonnet-4-5`) |

## Architecture

Handler / Service / Repository with InversifyJS (workspace rule):

- `handlers/workflow.handler.ts` — orchestrates the pipeline, prints the gate.
- `services/decompose.service.ts` — PRD → `ProductStory[]` (right-sizing prompt).
- `services/spec-synthesis.service.ts` — stories → tasks + envelope → validated
  ADR-0008 Markdown.
- `repositories/` — PRD parsing (`prd`), model transport (`anthropic`),
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
