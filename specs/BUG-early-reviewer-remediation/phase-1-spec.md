---
id: SPEC-BUG-early-reviewer-remediation-P1
prd: BUG-early-reviewer-remediation # synthetic id — lightweight bug path, no PRD file
phase: 1
status: Approved # Draft | Approved | Done | Superseded
date: 2026-08-07
owner: Russ Watson
envelope:
  allowedPaths:
    [
      'sdlc-workflow/src/handlers/run.handler.ts',
      'sdlc-workflow/src/__tests__/run.handler.test.ts',
      'sdlc-workflow/src/services/gate-remediation.service.ts',
      'sdlc-workflow/src/__tests__/gate-remediation.service.test.ts',
      'specs/BUG-early-reviewer-remediation/**',
      'CHANGELOG.md'
    ]
  forbiddenSurfaces: ['ci-config', 'personal-queue-schema']
  maxDiffLines: 400
  budgetK: 150
---

# SPEC-BUG-early-reviewer-remediation-P1: Remediate reviewer/envelope breaches before sandbox deploy

> Copy of `rosetta_docs/product/BUG-SPEC-TEMPLATE.md` filled for this bug
> (lightweight bug entry into the same spec-run-verify-merge machine).

## Context

**Symptom:** When the reviewer (or envelope) gate breaches, the engine still
runs the rest of the gate pipeline — including a full sandbox deploy that
often takes 5–10+ minutes — before `remediationRound` fires. The operator
sees a red `sdlc/reviewer` status and waits on Deploy Organization even
though remediation does not use the sandbox result. A successful fix changes
`headSha`, so the deploy that just completed is discarded and must run again
on the remediated tip. Observed live on admissions Phase 0l T-02
([Comita-Health/comita_admissions#396](https://github.com/Comita-Health/comita_admissions/pull/396)):
reviewer breach logged, then ~6+ minutes of sandbox with empty
`gateFixAttempts` / `remediations` while nobody addressed the finding.

**Repro:** Enforce-run a task whose reviewer gate returns `breach` (any
deterministic checklist failure). Observe heartbeat/step order:
`reviewer` → `verification` (test tier) → `sandbox` (long) → … → `phase` →
only then `[remediate]`. Confirm sandbox `stepElapsedMs` grows while
`remediations` in `state.json` stays empty.

**Root cause:** `RunHandler.taskPipeline` places `remediationRound` after
phase aggregation (`run.handler.ts`), which only runs once CI + sandbox +
verification have completed. `remediationRound` is already limited to
reviewer + envelope verdicts — it never remediates sandbox/CI — so waiting
on those gates before remediation is pure latency for that finding class.

**Why now / blast radius:** Burns wall-clock and sandbox/CI minutes on every
reviewer-red task during live PRD-0004 / PRD-0020 runs; trains the operator
to manually fix findings the engine would have fixed minutes earlier.
Engine-internal only (`sdlc-workflow/src/**`); no CI-config or queue-schema
surface changes. Gate semantics (what is remediable, budgets, fail-closed
escalation) stay the same — only **when** remediation starts moves earlier.

## Task T-01: Remediate reviewer/envelope red before sandbox

- **Story:** S-01
- **Complexity:** S
- **Depends on:** []

After envelope and reviewer gates complete, if either is remediable-red and
this is an enforce run, invoke the existing `remediationRound` **before**
sandbox deploy (and before the remainder of verification/CI that depends on
continuing the current head). On successful remediation (`kind ===
'remediated'`), abandon the current pipeline pass exactly as today's
post-phase path does — return so re-selection re-gates the new head from
the top (envelope onward). Do **not** change remediable-finding selection,
attempt budgets, or escalation suppression rules — reuse
`remediationRound` / `GateRemediationService` as-is.

If remediation is skipped or fails, continue the existing pipeline (sandbox
→ verification → CI → phase → post-phase remediation attempt / escalate) so
behavior for non-remediable red and exhausted budgets stays loud and
unchanged.

Do not remediate on sandbox/CI/verification red in this early slot — those
findings still wait for phase aggregation (out of scope). Shadow runs remain
non-remediating.

### Acceptance criteria

- [ ] test: when reviewer returns remediable `breach` in enforce mode, the
      handler invokes remediation **before** sandbox deploy is called (mock
      order: reviewer → remediate; sandbox not called on that pass when
      remediation succeeds)
- [ ] test: successful early remediation abandons the pass (no sandbox/CI on
      the superseded head) so the next selection re-runs gates on the new tip
- [ ] test: when remediation is skipped/fails, sandbox still runs afterward
      (pipeline continues; no silent drop of the deploy gate)
- [ ] test: envelope remediable-red follows the same early path as reviewer
- [ ] test: shadow mode never early-remediates (unchanged)
- [ ] test: adjacent green path unchanged — when envelope + reviewer both
      `pass`, sandbox is still invoked and no early remediation runs
- [ ] agent: diff is confined to the early-remediation reorder and its tests —
      no unrelated refactor of gate services or remediation budgets
