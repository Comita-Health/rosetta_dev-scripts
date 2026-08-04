---
id: SPEC-PRD-0024-P1
prd: PRD-0024
phase: 1
status: Approved # Draft | Approved | Done | Superseded
date: 2026-08-04
owner: Russ Watson
envelope:
  allowedPaths: ['team-setup/**', 'CHANGELOG.md']
  forbiddenSurfaces: ['ci-config', 'personal-queue-schema']
  maxDiffLines: 1400
  budgetK: 200
---

# SPEC-PRD-0024-P1: Phase 1 of PRD-0024 delivers the workspace grounding config foundation (objective-doc, design-method, and design-token declarations) and the generic /strategize skill, so any consumer workspace can get a grounded proceed/improve/park/decline assessment of an intake idea against its own declared business objectives without any consumer-specific paths baked into the skill.

## Context

PRD-0024 introduces three planning-side skills (/strategize, /design-ux, and a right-sizing checkpoint) that must be generic templates driven by a workspace-declared grounding config rather than hardcoded consumer paths. Phase 1 scopes to the grounding config itself and /strategize only (stories S-01 and the /strategize-relevant slice of S-05); /design-ux, the right-sizing checkpoint, and the spec-template UX section (S-02, S-03, S-04) are explicitly deferred to later phases and must not be modified here. The grounding config schema is built out fully (objective docs, design method, design tokens) so later phases can consume it without rework, but this phase only wires /strategize to the objectives portion. All deliverables live in team-setup (skill templates under `team-setup/templates/root/.cursor/skills/` and `.claude/skills/`, config template and loader convention alongside them, distribution via the existing sync manifest); the populated Comita config is instantiated in the Comita workspace root as the first real consumer and validated live. /strategize remains assistive: it reads and reports, never writes objectives, and never autonomously advances an idea past the spec + envelope Approve step.

## Task T-01: Define workspace grounding config schema and loader convention

- **Story:** S-05
- **Complexity:** S
- **Depends on:** []

Create the grounding config file format (a schema/template distributed to workspace roots via team-setup) with fields for objectiveDocs (array of paths), designMethod, and designTokens, so later phases (design-ux) can reuse it without schema churn. Only objectiveDocs is consumed in this phase. Ship a shared loader convention (a script or documented resolution procedure the skill body follows) that any skill can use to resolve declared paths; it must fail soft (empty result) rather than error when a workspace config or field is absent, and must contain zero consumer-specific values itself.

### Acceptance criteria

- [ ] test: A grounding config schema/template file exists with fields for objectiveDocs, designMethod, and designTokens, and contains no consumer-specific values.
- [ ] test: A shared config-loader module or script exists that parses a workspace grounding config and returns the declared objectiveDocs paths.
- [ ] test: The config loader returns an empty result without erroring when the grounding config file or the objectiveDocs field is absent.
- [ ] agent: Loading a fixture grounding config populated with sample objective doc paths returns those paths unchanged via the loader.

## Task T-02: Author generic /strategize skill body grounded on the config loader

- **Story:** S-01
- **Complexity:** M
- **Depends on:** [T-01]

Write the /strategize skill markdown as a template: it resolves objective docs exclusively through the T-01 loader convention, never references a fixed path or product name, and reads/quotes those docs rather than paraphrasing from memory. Skill instructions must explicitly forbid writing or inventing objectives on the consumer's behalf.

### Acceptance criteria

- [ ] test: The /strategize skill body contains zero consumer-specific document paths, product names, or domain rules.
- [ ] test: The /strategize skill body's grounding-resolution step invokes the shared config loader rather than a hardcoded file reference.
- [ ] agent: Running /strategize on a sample intake in a workspace whose grounding config declares sample objective docs produces a structured assessment that cites those objective docs by name.
- [ ] agent: The assessment produced by /strategize contains no objective statement that is absent from the cited objective docs.

## Task T-03: Implement structured recommendation, risks, and missing-context sections

- **Story:** S-01
- **Complexity:** M
- **Depends on:** [T-02]

Define the /strategize output template with a single constrained recommendation field and mandatory risks + missing-context sections. Reinforce in the skill body that this is an assistive step inside the human planning conversation: it must not edit the intake, spec, or envelope Approve state.

### Acceptance criteria

- [ ] test: The /strategize output template defines exactly one recommendation field constrained to one of: proceed-with-shape, improve, park, decline.
- [ ] test: The /strategize output template defines a required risks section and a required missing-context section.
- [ ] agent: Running /strategize on a sample intake produces an assessment whose recommendation field is set to one of the four allowed values.
- [ ] agent: Running /strategize on a sample intake produces an assessment with a non-empty risks section and a non-empty missing-context section.
- [ ] agent: Running /strategize on a sample intake leaves the intake doc, spec, and envelope Approve state unmodified.

## Task T-04: Flag missing-objectives gap instead of fabricating objectives

- **Story:** S-01
- **Complexity:** S
- **Depends on:** [T-02]

Add an explicit branch in the /strategize skill body for the zero-objective-docs case returned by the loader: the first finding in the assessment must name the gap, and generation of any objective-like content must be suppressed for that run.

### Acceptance criteria

- [ ] test: The /strategize skill body includes an explicit instruction branch for the case where the config loader resolves zero objective docs.
- [ ] agent: Running /strategize in a workspace with no objectives declared produces an assessment whose first finding flags the missing-objectives gap.
- [ ] agent: Running /strategize in a workspace with no objectives declared produces no fabricated objective statements anywhere in the output.

## Task T-05: Instantiate the Comita workspace grounding config as first consumer

- **Story:** S-05
- **Complexity:** S
- **Depends on:** [T-01]

Prove the schema against non-fixture data with Comita as the first real consumer. The in-repo deliverable is a documented population example (realistic field values in the template docs, no Comita-specific values in the synced template itself); the populated instance is created in the Comita workspace root — outside this repo — with objectiveDocs pointing at its workbook and foundations docs and designMethod pointing at its design-method doc (unconsumed until /design-ux ships), and validated live.

### Acceptance criteria

- [ ] test: The template documentation includes a worked population example covering objectiveDocs and designMethod fields.
- [ ] agent: The Comita workspace root contains a populated grounding config declaring objectiveDocs paths for its workbook and foundations docs and a designMethod path, conforming to the T-01 schema.
- [ ] agent: Running /strategize in the Comita workspace with this config produces an assessment citing the Comita workbook and/or foundations docs by name.

## Task T-06: Sync /strategize and grounding config template to consumer workspaces

- **Story:** S-05
- **Complexity:** M
- **Depends on:** [T-02, T-05]

Add the /strategize skill file and the grounding config template (not the populated Comita instance) to the existing team-setup sync manifest so both the Claude and Cursor skill layouts pick it up. Design-ux and the right-sizing checkpoint are not part of this sync yet since they ship in a later phase.

### Acceptance criteria

- [ ] test: The team-setup sync manifest includes the /strategize skill file and the grounding config template among synced assets.
- [ ] test: The synced grounding config template contains only placeholder values, with no Comita-specific paths.
- [ ] agent: Running the team-setup sync against a fresh consumer workspace produces a /strategize skill file present in both the Claude skill layout and the Cursor skill layout.
