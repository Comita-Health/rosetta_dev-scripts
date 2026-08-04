---
id: SPEC-BUG-ci-typecheck-gate-P1
prd: BUG-ci-typecheck-gate # synthetic id — lightweight bug path, no PRD file
phase: 1
status: Approved # Draft | Approved | Done | Superseded
date: 2026-08-04
owner: Russ Watson
envelope:
  allowedPaths:
    [
      '.github/workflows/ci.yml',
      'sdlc-workflow/package.json',
      'team-setup/package.json',
      'specs/BUG-ci-typecheck-gate/**',
      'CHANGELOG.md'
    ]
  forbiddenSurfaces: ['personal-queue-schema']
  maxDiffLines: 150
  budgetK: 150
---

# SPEC-BUG-ci-typecheck-gate-P1: CI never type-checks, so `tsc` errors ride onto main silently

## Context

**Symptom:** A duplicate object property (`TS1117`) and a missing interface
member (`TS2741`) sat on `main` undetected after a merge, discovered only by
manually running `bun run build`. CI reported green the whole time.

**Repro:** Introduce any `tsc`-only error (duplicate object key, type
mismatch, missing interface member) in `sdlc-workflow/src/**` or
`team-setup/src/**`, push a PR, and watch `.github/workflows/ci.yml` pass —
it runs `bun run test:coverage` (jest via `@swc/jest`) for each package, and
`@swc/jest` strips TypeScript types without checking them. There is no `tsc`
step anywhere in CI.

**Root cause:** `ci.yml`'s `test` job only ever runs the jest suites; nothing
in the pipeline runs the TypeScript compiler in check mode, so a class of
defect the language is supposed to catch is invisible to every gate
(including this engine's own reviewer/CI gates) until someone runs the build
by hand.

**Why now / blast radius:** The fix edits `.github/workflows/ci.yml`, which
is the `ci-config` protected surface (`.sdlc/surfaces.json`) — normally
forbidden to ordinary tasks. This spec's envelope deliberately omits
`ci-config` from `forbiddenSurfaces` (the fix's whole purpose is to touch
it), which is exactly the "touches a forbidden surface" case the bug
template flags for the full machine: reviewer gate + human approval on the
CI edit, rather than a silent direct push. Engine-only change (CI tooling in
`rosetta_dev-scripts`); no consumer coupling.

## Task T-01: Add a `tsc --noEmit` typecheck step to CI for both workspace packages

- **Story:** S-01
- **Complexity:** S
- **Depends on:** []

Add a `"typecheck": "tsc --noEmit"` script to `sdlc-workflow/package.json`
and `team-setup/package.json` (alongside the existing `"build": "tsc"`), and
add a step per package in `.github/workflows/ci.yml`'s `test` job that runs
`bun run typecheck`, placed before that package's `test:coverage` step so a
type error fails fast. Do not touch `team-setup/addi-merge-webhook` (it is
not covered by CI today and is out of scope here). Do not change `build` or
any test script.

### Acceptance criteria

- [ ] test: `bun run typecheck` (defined as `tsc --noEmit`) exits `0` in both
      `sdlc-workflow` and `team-setup` on the current tree.
- [ ] agent: with a deliberate type error temporarily introduced in a scratch
      file in one package (e.g. a duplicate object property or a value
      assigned to a mismatched type), `bun run typecheck` in that package
      exits non-zero and names the error; the scratch file is then removed
      and the tree left clean — this is the regression proof that the gate
      fails loud instead of passing silently like the jest suite does.
- [ ] agent: `.github/workflows/ci.yml`'s `test` job runs a typecheck step
      for each of `team-setup` and `sdlc-workflow` before that package's
      existing test step, and this task's own PR shows both typecheck steps
      executing (and passing) in its CI run.
- [ ] agent: diff is confined to the two `package.json` scripts, `ci.yml`,
      `CHANGELOG.md`, and this spec's own file — no source/logic changes in
      `src/**`.

## Out of scope

- Adding typecheck coverage for `team-setup/addi-merge-webhook` (not in CI
  today; separate concern).
- Any change to `build`, `test`, or `test:coverage` scripts.
- Turning this into a separate parallel CI job (kept as sequential steps in
  the existing `test` job for minimal diff).
