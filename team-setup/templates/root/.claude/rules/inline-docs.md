# Inline documentation (TSDoc / JSDoc)

**Documentation quality is part of the SDLC bar** — the same class of requirement as
Handler / Service / Repository shape and Conventional Commits. Reviewer agents and
human reviewers treat a missing or hollow doc on a new export the same as a missing
test when the surface warrants it.

## Backend / engine TypeScript (HSR and CLIs)

Every **new or substantially changed** `@injectable()` Handler, Service, or Repository
class (and each new public method on those classes) MUST have a TSDoc block that covers:

1. **Purpose** — what this type/method is for in one or two sentences (not a restatement
   of the class name).
2. **Non-obvious invariants** — authz, PHI/PII boundaries, idempotency, ordering,
   failure modes, or “when not to call this.”
3. **`@remarks` / `@example`** when a call is easy to misuse or when the contract is
   richer than the TypeScript types alone.

Do **not** add redundant `@param` / `@returns` lines that only restate TypeScript types.
Prefer types for shape; prefer TSDoc for _why_ and _constraints_.

Pure helpers in `src/utils/` follow the same rule when exported or non-trivial.

## Frontend / React

- **TypeScript types and props interfaces are the primary API docs** for components.
- Add short TSDoc on **non-obvious exports** (platform helpers, auth/session utilities,
  entitlement math, hooks with side effects): purpose, constraints, `@remarks`.
- Do **not** require a JSDoc encyclopedia on every presentational prop.
- Component _behavior_ belongs in unit tests (and Storybook when the package uses it),
  not in long `@param` lists that duplicate `interface` fields.

## What “robust” means in review

Pass when a new reader can answer: _What is this for? What must I not break? Where
does it sit in the blast radius?_ Fail when docs are absent on a new HSR class, or are
placeholder noise (`/** Service */`, `@param x - the x`).

## Enforcement

1. **Spec acceptance criteria** may call out docs for a task explicitly.
2. The **sdlc-workflow reviewer prompt** includes this checklist for every task review.
3. Optional later: `eslint-plugin-jsdoc` / TSDoc lint for mechanical presence — does not
   replace useful prose.
