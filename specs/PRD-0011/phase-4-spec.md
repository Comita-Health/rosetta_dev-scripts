---
id: SPEC-PRD-0011-P4
prd: PRD-0011
phase: 4
status: Approved # Draft | Approved | Done | Superseded
date: 2026-08-02
owner: Russ Watson
envelope:
  allowedPaths:
    [
      'sdlc-workflow/**',
      'specs/PRD-0011/**',
      'CHANGELOG.md',
      'team-setup/templates/**'
    ]
  forbiddenSurfaces:
    [
      'migrations',
      'auth',
      'ci-config',
      'production-deploy',
      'personal-queue-schema'
    ]
  maxDiffLines: 800
  budgetK: 80
---

# SPEC-PRD-0011-P4: Path-aware sandbox deploy (skip / thin-dispatch)

## Context

[PRD-0011](https://github.com/Rosetta-Foundation/rosetta_docs/blob/main/product/PRD-0011-full-loop-sdlc-automation.md)
Phases 1–3 shipped a full-loop SDLC with a sandbox gate that deploys the task
branch (or merged tip) via the repo-owned `.sdlc/environments.json` contract
and requires health output to echo `SDLC_SANDBOX_SHA`.

Live pain (Comita Admissions `PR #302` / run `prd-0004-p1a-2026-08-02` T-01):
the task changed only an inventory doc and shared **unit tests**. The sandbox
gate still dispatched `deploy-organization.yml` with `backend=true` and
`frontend=true` and waited for the live app to serve that SHA — many minutes
for zero functional ship.

Root cause: admissions `scripts/sdlc/sandbox-deploy.sh` always
`workflow_dispatch`es both stacks. Path filters in
`.github/path-filters.yml` apply on `push`, not on that dispatch. Reusing the
`frontend` filter alone would still deploy for `packages/app/shared/**` test
files. Skip policy must treat docs / `__tests__` / `*.test.ts` as
non-deployable even under otherwise deployable trees.

**Engine stays path-agnostic** except for exporting `SDLC_SANDBOX_BASE_SHA`
(task gate base). **Path policy is repo-owned** (first consumer:
`comita_admissions`). Companion implementation in admissions is out of this
envelope’s allowedPaths and lands as a parallel PR referenced from T-02/T-03.

## Task T-01: Pass `SDLC_SANDBOX_BASE_SHA` from the engine

- **Story:** S-01
- **Complexity:** S
- **Depends on:** []

Extend `SandboxDeployInput` with optional `baseSha`. `SandboxDeployService`
exports `SDLC_SANDBOX_BASE_SHA` (alongside `SDLC_SANDBOX_SHA`) on both deploy
and health shell runs. `run.handler` `sandboxStep` (and phase-deploy /
check-veto redeploy call sites) supply the task integration tip / gate base
when known.

### Acceptance criteria

- [x] test: deploy + health `run()` calls include `SDLC_SANDBOX_BASE_SHA` when
      `baseSha` is provided on the input.
- [x] test: when `baseSha` is omitted, only `SDLC_SANDBOX_SHA` is exported
      (scripts may fall back to `git merge-base`).
- [x] test: existing SHA-idempotent “already healthy” behavior is unchanged.

## Task T-02: Admissions ignore list + path decision helper (companion PR)

- **Story:** S-01
- **Complexity:** M
- **Depends on:** []

In `comita_admissions` (parallel PR, not this envelope):

1. Add `.sdlc/sandbox-deploy-ignore.yml` with globs that never require a
   sandbox ship (at minimum: `docs/**`, `specs/**`, `**/*.md`,
   `**/__tests__/**`, `**/*.test.ts`, `**/*.test.tsx`, `**/*.spec.ts`,
   `.sdlc/**`).
2. Add `scripts/sdlc/sandbox-path-decision.py` that, given `base..head`,
   returns `skip` | `backend` | `frontend` | `both` by (a) ignore-matching
   all files → `skip`, else (b) classifying remaining files against
   `.github/path-filters.yml` `backend` / `frontend`.

### Acceptance criteria

- [x] test: docs + `**/__tests__/**` only → `skip` (#302-shaped).
- [x] test: shared **source** under `packages/app/shared/**` (non-test) →
      `frontend` (or `both` if backend also matches).
- [x] test: backend handler path only → `backend`.
- [ ] test: empty diff → `skip`. **Deliberately not implemented — an empty
      diff resolves to `both`.** No files at all means the refs were wrong (a
      stale base, or a head that is not the commit being deployed), not that
      nothing shipped; answering `skip` there lets health self-report a SHA it
      never probed, which is a green gate on unverified code. Locked in by
      `test_empty_diff_ships_rather_than_skipping`. A real diff of only
      ignorable files is the legitimate skip and is covered.

## Task T-03: Wire admissions sandbox-deploy / sandbox-health (companion PR)

- **Story:** S-01
- **Complexity:** M
- **Depends on:** [T-02]

Update `scripts/sdlc/sandbox-deploy.sh` and `sandbox-health.sh`:

- Resolve base from `SDLC_SANDBOX_BASE_SHA` or
  `git merge-base HEAD origin/build-env/dev`.
- **skip:** deploy exits 0 without workflow dispatch; health prints
  `healthy sha=$SDLC_SANDBOX_SHA skipped=no-deployable-paths ...` (no live
  curl) so the engine SHA echo contract holds.
- **backend / frontend:** dispatch with only the matching
  `-f backend=` / `-f frontend=` flags; health keeps live `x-app-version`
  SHA check.
- **both:** current both-true behavior.
- Document in `docs/sdlc-contracts.md`. Note: `agent:`-tier criteria needing
  a live build of this SHA still require a deployable path change.

### Acceptance criteria

- [x] test: decision `skip` → deploy script does not call `gh workflow run`.
- [x] test: decision `skip` → health stdout contains `SDLC_SANDBOX_SHA` and
      `skipped=no-deployable-paths`.
- [x] test: decision `frontend` → dispatch includes `frontend=true` and
      `backend=false` (and the inverse for `backend`).
- [x] docs: `docs/sdlc-contracts.md` describes ignore file + skip/partial/full.

## Task T-04: Engine docs / changelog for the BASE_SHA contract

- **Story:** S-01
- **Complexity:** S
- **Depends on:** [T-01]

Document `SDLC_SANDBOX_BASE_SHA` in `sdlc-workflow/README.md` (sandbox
contract section) and note Phase 4 in `CHANGELOG.md`. Optionally sync a
one-line pointer into team-setup templates if they document sandbox env
vars.

### Acceptance criteria

- [x] docs: README states both `SDLC_SANDBOX_SHA` and `SDLC_SANDBOX_BASE_SHA`
      and that path skip/thin-dispatch is repo-owned.
- [x] docs: CHANGELOG mentions SPEC-PRD-0011-P4 / path-aware sandbox.

## Out of scope

- Changing PR Checks / dorny filters (CI should still run unit tests for
  test-file edits).
- Skipping local `verification.json` `testCommand`.
- Rewriting historical run state for prior Comita Phase 1a tasks.
