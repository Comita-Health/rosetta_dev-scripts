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

# SPEC-BUG-early-reviewer-remediation-P1: Never sandbox-deploy a reviewer/envelope-red head

> Copy of `rosetta_docs/product/BUG-SPEC-TEMPLATE.md` filled for this bug
> (lightweight bug entry into the same spec-run-verify-merge machine).

## Context

**Symptom:** When the reviewer (or envelope) gate breaches, the engine still
runs the rest of the gate pipeline — including a full sandbox deploy that
often takes 5–10+ minutes — before `remediationRound` fires. That is
wasteful of **time and of the sandbox itself**: Deploy Organization ships
code the reviewer already rejected. Remediation (when it eventually runs)
changes `headSha`, so the deploy is discarded and must run again on the
fixed tip. Observed live on admissions Phase 0l T-02
([Comita-Health/comita_admissions#396](https://github.com/Comita-Health/comita_admissions/pull/396)):
reviewer breach logged, then a long sandbox on the red head while
`remediations` stayed empty.

**Repro:** Enforce-run a task whose reviewer gate returns `breach` (any
deterministic checklist failure). Observe heartbeat/step order:
`reviewer` → `verification` (test tier) → `sandbox` (long) → … → `phase` →
only then `[remediate]`. Confirm sandbox runs against the red `headSha`.

**Root cause:** `RunHandler.taskPipeline` places `remediationRound` after
phase aggregation (`run.handler.ts`), which only runs once CI + sandbox +
verification have completed. Sandbox is not gated on reviewer/envelope
green, so a failed review still deploys.

**Why now / blast radius:** Burns wall-clock and deploys known-bad tips on
every reviewer-red task. Engine-internal only (`sdlc-workflow/src/**`); no
CI-config or queue-schema surface changes. Remediable-finding selection and
budgets stay the same; the change is **skip sandbox (and downstream gates
that assume continuing this head) on reviewer/envelope non-pass**, and run
remediation immediately when applicable.

## Task T-01: Skip sandbox on reviewer/envelope red; remediate first

- **Story:** S-01
- **Complexity:** S
- **Depends on:** []

After envelope and reviewer gates complete in an enforce run:

1. If **either** is non-pass (`breach` / remediable red / blocked that fails
   the phase), **do not** call sandbox deploy (or CI) for the current head.
   Deploying a tip the reviewer already rejected is out of scope for this
   pipeline pass.
2. If the finding is remediable, invoke the existing `remediationRound`
   immediately (same service/budgets/escalation-suppression as today). On
   `kind === 'remediated'`, abandon the pass so re-selection re-gates the
   new head from the top (envelope onward) — sandbox only runs once
   envelope + reviewer are green on that new tip.
3. If remediation is skipped or fails, escalate / halt as today — still
   **without** sandbox-deploying the red head. Do not fall through to
   "continue the pipeline including sandbox" for reviewer/envelope red.

Do not change remediable-finding selection, attempt budgets, or shadow
behavior (shadow remains non-remediating). Sandbox/CI/verification-only red
still uses the existing post-phase path (out of scope for this early skip).

### Acceptance criteria

- [x] test: when reviewer returns non-pass in enforce mode, sandbox deploy
      is **never** called for that head (whether or not remediation runs)
- [x] test: when reviewer returns remediable `breach`, remediation is
      invoked before any sandbox call; on success the pass abandons and the
      next selection re-gates the new tip
- [x] test: when remediation is skipped or fails on reviewer/envelope red,
      sandbox is still **not** called; escalation/halt path remains loud
- [x] test: envelope non-pass follows the same skip-sandbox + optional
      early-remediation path as reviewer
- [x] test: shadow mode never early-remediates and keeps today's gate order
      (unchanged)
- [x] test: adjacent green path unchanged — when envelope + reviewer both
      `pass`, sandbox is still invoked
- [ ] agent: diff is confined to the skip-sandbox / early-remediation reorder
      and its tests — no unrelated refactor of gate services or budgets
