---
id: SPEC-BUG-envelope-spec-integrity-P1
prd: BUG-envelope-spec-integrity # synthetic id — lightweight bug path, no PRD file
phase: 1
status: Approved # Draft | Approved | Done | Superseded
date: 2026-08-04
owner: Russ Watson
envelope:
  allowedPaths:
    [
      'sdlc-workflow/src/**',
      'sdlc-workflow/README.md',
      'specs/BUG-envelope-spec-integrity/**',
      'CHANGELOG.md'
    ]
  forbiddenSurfaces: ['ci-config', 'personal-queue-schema']
  maxDiffLines: 800
  budgetK: 200
---

# SPEC-BUG-envelope-spec-integrity-P1: Envelopes are grounded in reality, surfaces fail closed, specs cannot lie

## Context

**Symptom:** The change-control envelope — the mechanism the whole
human-approval model leans on — is built from untrusted inputs. Observed
live: (a) decompose synthesizes `allowedPaths` purely from LLM guesses with
no repo-tree grounding, producing envelopes that miss real paths or allow
imaginary ones ([#35]); (b) `forbiddenSurfaces` labels that don't resolve
against the target repo's `.sdlc/surfaces.json` are silently dropped at
synthesis — including `regulated-data-boundary` on a consumer product, the
worst possible silent drop ([#36]); (c) the envelope gate reads
`surfaces.json` from the operator's local checkout rather than the tree
under judgment; (d) agents can tick their own acceptance checkboxes inside
product diffs ([#40]); (e) a Prettier pass once reshaped a spec's inline
envelope YAML into a form the parser rejected, halting intake.

**Repro:** (a) run `decompose` against any PRD and diff the synthesized
`allowedPaths` against the repo tree; (b) put a typo'd surface label in a
PRD's constraints and observe it vanish from the spec; (c) edit
`surfaces.json` locally and watch the gate judge with the edited copy;
(d) craft a task diff that edits its own spec checkboxes; (e) run Prettier
with default settings over a spec whose envelope uses inline arrays.

**Root cause:** Synthesis validates shape, not truth: no filesystem
grounding, fail-open label resolution, no single-source rule for contract
blobs, and no format lint guarding the one file format both humans and the
machine must agree on. Some hardening may exist already (enforce intake
validates labels; envelope hard-breach on `specs/**` is documented) —
**each task verifies current behavior on `main` first and reduces to
regression tests where the guarantee already holds.**

**Why now / blast radius:** The envelope is the compliance boundary; a
silently-dropped consumer surface label is a categorical guardrail
failure. Engine-internal only; consumer surface _contents_ stay
consumer-owned (`regulated-data-boundary` remains a consumer label in the
consumer's `surfaces.json`).

## Task T-01: Ground synthesized `allowedPaths` in the target repo tree (#35)

- **Story:** S-01
- **Complexity:** M
- **Depends on:** []

At synthesis, every `allowedPaths` glob must either match at least one
existing path in the target repo tree or be explicitly justified as a
new-path intent (e.g. the task creates `src/services/foo.service.ts`);
ungrounded globs fail synthesis with a named error listing the offending
globs. Additionally, the diff-forecast heuristic: paths named in task
engineering notes that fall outside the envelope produce a synthesis-time
warning so the human reviews a coherent envelope instead of discovering the
gap as a mid-run breach.

### Acceptance criteria

- [x] test: a glob matching nothing in the repo tree and carrying no
      new-path justification fails synthesis with the glob named in the
      error.
- [x] test: new-file intents pass grounding when justified; existing-path
      globs pass unchanged.
- [x] test: a task note referencing a path outside the envelope surfaces a
      warning in the synthesis output.

## Task T-02: `forbiddenSurfaces` fail closed at synthesis (#36)

- **Story:** S-01
- **Complexity:** S
- **Depends on:** []

Surface labels present in the PRD/spec inputs that do not resolve against
the target repo's `.sdlc/surfaces.json` must fail synthesis loudly (named
label, available labels listed) — never be silently dropped. Verify-first:
enforce intake already validates resolved specs; the defect is upstream at
synthesis time where labels vanish before any human sees the spec.

### Acceptance criteria

- [x] test: an unresolvable surface label aborts synthesis with the label
      and the repo's known labels in the error; nothing is dropped.
- [x] test: a spec whose labels all resolve synthesizes byte-identically to
      current behavior.
- [x] test: regression — an arbitrary consumer label unknown to the
      engine round-trips PRD → spec → intake without loss.

## Task T-03: Contract blobs are read from the tree under judgment

- **Story:** S-01
- **Complexity:** S
- **Depends on:** []

The envelope gate (and any gate reading `.sdlc/` contracts per-evaluation)
resolves `surfaces.json` from the git tree it is judging — the task's PR
tip (or the merged integration tip for phase-level checks) — not from the
operator's local checkout. A missing contract at that tree is a named
intake/gate error, not a fallback to local disk.

### Acceptance criteria

- [x] test: a locally modified (uncommitted) `surfaces.json` does not
      influence a gate verdict; the PR-tip blob does.
- [x] test: contract missing from the judged tree → named error verdict,
      not local-file fallback.
- [x] agent: audit call sites reading `.sdlc/` at evaluation time and align
      them to the same tree-resolution rule (documented in README).

## Task T-04: Spec self-ticking pinned and the spec format linted (#40)

- **Story:** S-01
- **Complexity:** S
- **Depends on:** []

Two integrity guards on the spec file itself. (1) Verify-first regression:
a product-task diff editing `specs/**` (including its own acceptance
checkboxes) hard-breaches the envelope gate even when `allowedPaths` would
cover it — pin end-to-end if already enforced, implement if not. (2) Add
`sdlc-workflow spec-lint --spec <path>`: validates front-matter parse,
envelope schema, and checkbox integrity (criteria present, tiers
recognized), with named errors — the guard that catches a
formatter-reshaped envelope (the Prettier incident) before intake does,
usable from hooks and CI.

### Acceptance criteria

- [ ] test: a task diff touching its own spec file breaches the envelope
      gate regardless of `allowedPaths`.
- [ ] test: `spec-lint` accepts every spec currently in `specs/**` on this
      repo and rejects a Prettier-reshaped envelope fixture with a named
      error.
- [ ] docs: README documents `spec-lint` and the single-writer rule for
      spec files (engine closeout owns checkbox state — PRD-0023).

## Out of scope

- Deriving checkbox state from verdicts and opening the closeout PR
  (PRD-0023 docs-closeout).
- Envelope/reviewer retrigger paths and verdict invalidation on new pushes
  (PRD-0021 self-healing).
- Any consumer's actual surface labels or `.sdlc/` contents (consumer-owned;
  the engine only enforces resolution).
