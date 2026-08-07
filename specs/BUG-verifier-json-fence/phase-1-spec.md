---
id: SPEC-BUG-verifier-json-fence-P1
prd: BUG-verifier-json-fence # synthetic id — lightweight bug path, no PRD file
phase: 1
status: Approved # Draft | Approved | Done | Superseded
date: 2026-08-07
owner: Russ Watson
envelope:
  allowedPaths:
    [
      'sdlc-workflow/src/utils/json-schema.ts',
      'sdlc-workflow/src/__tests__/utils.test.ts',
      'specs/BUG-verifier-json-fence/**',
      'CHANGELOG.md'
    ]
  forbiddenSurfaces: ['ci-config', 'personal-queue-schema']
  maxDiffLines: 200
  budgetK: 100
---

# SPEC-BUG-verifier-json-fence-P1: A leading non-JSON fence must not fail a passing gate

## Context

**Symptom:** A verifier agent that passed its criterion had the verdict
recorded as a **failure**, which breached the verification gate, breached the
phase gate, escalated `merge-blocked`, and blocked an otherwise-green merge.
Observed live on PRD-0020 Phase 1 T-03
([Rosetta-Foundation/rosetta_dev-scripts#165](https://github.com/Rosetta-Foundation/rosetta_dev-scripts/pull/165)):
reviewer, CI, and sandbox all passed on the same head, and the stored evidence
file opens with `**Pass.**` and ends with a well-formed
`{ "pass": true, … }` payload — yet the recorded reason was
`failed: agent: listing watches through the registry API returns kind, target,
age, and last-poll-time fields`, with `[verifier error] no JSON object found in
response` appended to the evidence.

**Repro:** Call `extractJson` with a response whose first fenced block is not
JSON — for example a progress checklist, which agent prompt conventions in this
workspace actively encourage:

````text
```markdown
- [x] Step 1: …
```

```json
{ "pass": true, "notes": ["…"] }
```
````

`extractJson` throws `no JSON object found in response` even though a valid
JSON fence is present later in the same response.

**Root cause:** `extractJson` in `sdlc-workflow/src/utils/json-schema.ts`
matches the **first** fence of any kind (`/```(?:json)?\s*([\s\S]*?)```/`),
commits to its contents, and then looks for braces only inside it. When the
first fence is a checklist, the candidate has no `{`, so the function throws
instead of considering the `json`-tagged fence that follows. There is no
fallback to other fences or to the raw response.

**Why now / blast radius:** This silently converts passing gate verdicts into
breaches, and the failure is self-reinforcing: escalation, a blocked merge, and
a remediation round that finds nothing to remediate because the code was never
wrong. It is not verifier-specific — `extractJson` is shared by
`verification.service.ts` and `inference.repository.ts`, so every
model-structured response (reviewer, decompose, verifier) carries the same
flake. Fix is confined to one pure utility plus its tests; no gate ordering,
prompt, or schema change.

## Task T-01: Prefer the JSON fence, fall back rather than throw

- **Story:** S-01
- **Complexity:** S
- **Depends on:** []

Make `extractJson` resilient to responses that wrap JSON in prose and multiple
fenced blocks.

1. Prefer an explicitly `json`-tagged fence when one is present, regardless of
   its position in the response.
2. Otherwise consider **every** fenced block in order and use the first that
   contains a balanced JSON object.
3. Otherwise fall back to scanning the raw response, as today.
4. Throw `no JSON object found in response` only when no candidate anywhere in
   the response yields parseable JSON — the error must mean "the model returned
   no JSON", never "the model returned JSON after something else".
5. When several candidates parse, prefer the `json`-tagged fence over an
   untagged one, and an earlier candidate over a later one, so a single
   response cannot silently change meaning based on incidental ordering.

Keep the function pure and its signature unchanged. Do not change
`validateJson`, gate ordering, verifier prompts, or the evidence format.

### Acceptance criteria

- [ ] test: a response whose first fence is ` ```markdown ` (a checklist) and
      whose later fence is ` ```json ` extracts the JSON payload
- [ ] test: a response with a single ` ```json ` fence still extracts, and an
      untagged fence containing an object still extracts (no regression)
- [ ] test: a response with JSON in surrounding prose and no fence at all still
      extracts (raw fallback preserved)
- [ ] test: a response with several fenced objects prefers the `json`-tagged
      one; with no tagged fence it prefers the earliest parseable one
- [ ] test: a response containing no JSON at all still throws
      `no JSON object found in response`
- [ ] test: a fence whose contents look like JSON but do not parse does not
      mask a later valid candidate
- [ ] agent: diff is confined to `extractJson` and its tests — `validateJson`,
      callers, and prompts unchanged
