---
id: SPEC-PRD-0011-P1
prd: PRD-0011
phase: 1
status: Approved # Draft | Approved | Done | Superseded
date: 2026-07-31
owner: Russ Watson
envelope:
  allowedPaths: ['sdlc-workflow/**', 'specs/PRD-0011/**']
  forbiddenSurfaces: ['ci-config', 'team-setup']
  maxDiffLines: 2500
  budgetK: 200
---

# SPEC-PRD-0011-P1: Decompose + Spec Generation Workflow

> A `sdlc-workflow` CLI package that takes a PRD ID and target repo, decomposes
> the PRD into product stories, synthesizes an ADR-0008 implementation spec
> with envelope, writes it to the target repo as Draft, and stops at the human
> gate. No implementation machinery — that is Phase 2.

## Context

This is rollout Phase 1 of
[PRD-0011](https://github.com/Rosetta-Foundation/rosetta_docs/blob/main/product/PRD-0011-full-loop-sdlc-automation.md)
(Full-Loop SDLC Automation): decompose + spec generation, pausing at the single
human gate. It validates decomposition and envelope quality before any
implementation automation exists. The spec format it emits is defined by
[ADR-0008](https://github.com/Rosetta-Foundation/rosetta_docs/blob/main/architecture/ADR-0008-implementation-spec-format.md);
data contracts (`ProductStory`, `SpecTask`, `Envelope`) come from PRD-0011 §4.
The package lives in `rosetta_dev-scripts` beside `team-setup`, follows the
HSR + InversifyJS pattern, and uses the TS7 + Bun toolchain (ADR-0006).

Stories sliced from PRD-0011 §7 Phase 1: S-01 (decompose a PRD into product
stories), S-02 (synthesize a valid implementation spec + envelope), S-03
(single-command CLI that stops at the human gate).

## Task T-01: Scaffold the `sdlc-workflow` package

- **Story:** S-03
- **Complexity:** S
- **Depends on:** []

Package skeleton mirroring `team-setup`: `package.json` (build/dev/test
scripts), `tsconfig.json` with decorator metadata per the HSR rule, jest via
`@swc/jest`, `reflect-metadata` + `inversify@^7`, yargs CLI entry, composition
root in `src/index.ts` binding all tokens. No business logic in the root.

### Acceptance criteria

- [ ] test: `bun run build` compiles cleanly with TypeScript strict mode.
- [ ] test: `sdlc-workflow --help` exits 0 and lists the `decompose` command.

## Task T-02: PRD repository

- **Story:** S-01
- **Complexity:** M
- **Depends on:** [T-01]

`IPrdRepository` resolves a PRD by ID from a docs directory (default:
`../rosetta_docs/product`, overridable) and parses frontmatter, goals,
non-goals, acceptance criteria, and rollout phases into a typed `ParsedPrd`.
Pure parsing helpers live in `src/utils/`.

### Acceptance criteria

- [ ] test: parses a PRD fixture (frontmatter fields, goals list, rollout
      phases with titles) into the typed structure.
- [ ] test: a missing PRD ID or malformed frontmatter produces a typed error,
      not a crash.

## Task T-03: Inference repository

- **Story:** S-01
- **Complexity:** M
- **Depends on:** [T-01]

`IInferenceRepository` wraps the model call (Claude API via
`ANTHROPIC_API_KEY`, per PRD-0011 §5) behind a schema-constrained interface:
callers pass a prompt and a JSON schema, get validated JSON back. One retry on
schema-invalid output, then a typed error. No business logic — prompt content
belongs to services.

### Acceptance criteria

- [ ] test: (mocked transport) schema-valid model output is returned parsed.
- [ ] test: (mocked transport) schema-invalid output triggers exactly one
      retry, then surfaces a typed error carrying the validation failure.

## Task T-04: Decompose service

- **Story:** S-01
- **Complexity:** M
- **Depends on:** [T-02, T-03]

`IDecomposeService.decompose(parsedPrd)` produces `ProductStory[]` (PRD-0011
§4) via the inference repository, with right-sizing guidance in the prompt
(PRD-0011 §6, scope-creep risk). Story IDs are sequential (`S-01`, …).

### Acceptance criteria

- [ ] test: (mocked inference) returns stories conforming to the
      `ProductStory` contract with sequential IDs.
- [ ] test: an empty or goal-less PRD yields a typed error rather than an
      empty story list.

## Task T-05: Spec synthesis service

- **Story:** S-02
- **Complexity:** M
- **Depends on:** [T-03]

`ISpecSynthesisService.synthesize(stories, options)` produces `SpecTask[]`
and an `Envelope` via the inference repository, then renders the ADR-0008
spec Markdown (frontmatter + task sections). A validator rejects specs with
untagged acceptance criteria, missing envelope fields, or unknown task
dependency references — ADR-0008 makes untagged criteria a format error.

### Acceptance criteria

- [ ] test: rendered output parses back: YAML frontmatter with all envelope
      fields, one section per task, every criterion carrying a
      `test:`/`agent:`/`manual:` tag.
- [ ] test: a criterion without a tier tag fails validation with an error
      naming the task and criterion.
- [ ] test: a task depending on an unknown task ID fails validation.

## Task T-06: Decompose command + human gate stop

- **Story:** S-03
- **Complexity:** M
- **Depends on:** [T-01, T-02, T-03, T-04, T-05]

`IWorkflowHandler` wires the pipeline behind
`sdlc-workflow decompose --prd PRD-NNNN --repo <path> [--phase 1] [--budget-k 200]`:
parse PRD → decompose → synthesize → write
`<repo>/specs/<PRD-ID>/phase-<n>-spec.md` with `status: Draft` → print the
gate instructions (review, then flip Draft → Approved in a dedicated commit)
→ exit 0. The command never proceeds past writing the Draft spec — the gate
is a hard stop by construction. Composition happens in the handler; services
do not call services.

### Acceptance criteria

- [ ] test: (mocked repositories) the command writes the spec to the expected
      path with `status: Draft` and prints gate instructions.
- [ ] test: a validation failure from synthesis exits non-zero and writes
      nothing.
- [ ] agent: run the CLI against a real PRD fixture end-to-end (live
      inference); confirm the generated spec passes the T-05 validator, lands
      at the correct path as Draft, and the terminal output makes the next
      human action unambiguous. Attach the generated spec as evidence.
