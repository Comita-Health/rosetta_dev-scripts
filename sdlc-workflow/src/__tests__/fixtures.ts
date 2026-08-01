import { Envelope, ProductStory, SpecTask } from '../types';

export const PRD_FIXTURE = `---
id: PRD-0099
title: Test Capability
status: Proposed
date: 2026-07-31
owner: Russ Watson
related_adrs: []
related_specs: []
supersedes: null
---

# PRD-0099: Test Capability

> One-liner.

## 1. Overview & Goals

### 1.1 Purpose

Why this exists.

### 1.2 Goals

- Do the first thing end to end.
- Do the second thing
  across two lines.

### 1.3 Non-Goals

- Do not boil the ocean.

### 1.4 Acceptance Criteria

- [ ] First observable condition.
- [ ] Second observable condition.

## 7. Rollout & Phases

1. **Phase 1 — Walk:** Ship the minimal loop.
2. **Phase 2 — Run:** Scale it out.
`;

export const makeStory = (
  overrides: Partial<ProductStory> = {}
): ProductStory => ({
  id: 'S-01',
  title: 'A story',
  asA: 'an engineer',
  iWant: 'a thing',
  soThat: 'value happens',
  acceptanceCriteria: ['it works'],
  ...overrides
});

export const makeTask = (overrides: Partial<SpecTask> = {}): SpecTask => ({
  id: 'T-01',
  storyId: 'S-01',
  phase: 1,
  title: 'Build the thing',
  engineeringNotes: 'Keep it simple.',
  complexity: 'M',
  dependsOn: [],
  acceptanceCriteria: ['test: the thing builds'],
  ...overrides
});

export const makeEnvelope = (overrides: Partial<Envelope> = {}): Envelope => ({
  allowedPaths: ['src/**'],
  forbiddenSurfaces: ['ci-config'],
  maxDiffLines: 1000,
  budgetK: 200,
  ...overrides
});
