---
id: SPEC-LIVE-VALIDATION-P3
prd: PRD-0011
phase: 3
status: Done # Draft | Approved | Done | Superseded
date: 2026-08-01
owner: Russ Watson
envelope:
  allowedPaths: ['docs/**']
  forbiddenSurfaces: ['ci-config']
  maxDiffLines: 200
  budgetK: 80
---

# SPEC-LIVE-VALIDATION-P3: Tiny one-task harness that drives the real SPEC-PRD-0011-P3 pipeline end to end against this repository, so the open agent-tier acceptance criteria (auto-merge on green, operator triage via status + escalation queue) can be validated with a live run instead of mocks.

## Context

SPEC-PRD-0011-P3 shipped with every test-tier criterion green; two agent-tier criteria require live-run evidence. This harness exists solely to produce that evidence in-repo: the implementation agent makes a small documentation-only change, the enforcing gates run (envelope, reviewer, verification, CI with fix cycle), and a green result auto-merges. A companion seeded partial-failure run exercises the T-06 status + escalation queue triage surface.

## Task T-01: Document the phase-3 live-validation run

- **Story:** S-02
- **Complexity:** S
- **Depends on:** []

Create `docs/live-validation-p3.md` containing a section titled "Phase 3 live validation" that states the file was produced by the SDLC workflow's implementation agent during the SPEC-PRD-0011-P3 live validation run, and lists the phase-3 stages in order: implementation, pr, envelope, reviewer, sandbox, verification, ci, phase, enforce/merge, phase-deploy, phase-digest. Keep the file under 50 lines. Do not modify any other file.

### Acceptance criteria

- [x] test: the sdlc-workflow build and test suite pass with the change applied
- [x] agent: on a live run, all gates green auto-merges the task PR and the recorded mergedSha matches the remote merge commit

> **Live evidence (2026-08-01, run `p3-live-val`):** CI on PR #32 ran green
> (2 check runs at `d8d3019278c1`), the enforcing gate merged the PR
> automatically, and the recorded mergedSha
> (`7bf2fdfb9712ab06306b171e7bda12549ddf33ae`) matches the remote merge
> commit. The merged default branch then deployed to the sandbox and the
> phase digest posted to the personal queue.
