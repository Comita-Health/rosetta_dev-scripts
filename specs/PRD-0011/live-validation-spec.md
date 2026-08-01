---
id: SPEC-LIVE-VALIDATION-P1
prd: PRD-0011
phase: 2
status: Approved # Draft | Approved | Done | Superseded
date: 2026-08-01
owner: Russ Watson
envelope:
  allowedPaths: ['docs/**']
  forbiddenSurfaces: ['ci-config']
  maxDiffLines: 200
  budgetK: 50
---

# SPEC-LIVE-VALIDATION-P1: A deliberately tiny one-task spec that drives the real SPEC-PRD-0011-P2 pipeline end to end against this repository, so the open agent-tier acceptance criteria (reviewer agent on a live diff, kill-resume mid-verification via the run-status interface) can be validated with a live run instead of mocks.

## Context

SPEC-PRD-0011-P2 shipped with every test-tier criterion green; three agent-tier criteria require live-run evidence. This harness spec exists solely to produce that evidence in-repo: the implementation agent makes a small documentation-only change, the local process sandbox (`.sdlc/environments.json` → `scripts/sandbox-*.sh`) stages the built CLI keyed by SHA, and the full shadow-gate pipeline runs over the result. Human approval recorded 2026-08-01 (Russ) as part of the sanctioned live test; the T-04 agent-tier criterion is validated separately against a real deployed sandbox by an external adopter.

## Task T-01: Document the live-validation run

- **Story:** S-05
- **Complexity:** S
- **Depends on:** []

Create `docs/live-validation.md` containing a section titled "Live validation" that states the file was produced by the SDLC workflow's implementation agent during the SPEC-PRD-0011-P2 live validation run, and lists the pipeline stages in order: implementation, envelope, reviewer, sandbox, verification, ci, phase. Keep the file under 40 lines. Do not modify any other file.

### Acceptance criteria

- [ ] test: the sdlc-workflow build and test suite pass with the change applied
- [ ] agent: the running sandbox's health interface reports the deployed commit SHA
