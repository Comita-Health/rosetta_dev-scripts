import { CloseoutAggregate, CloseoutCriterion } from '../types';
import {
  applyCloseout,
  closeoutBody,
  closeoutBranch,
  closeoutMarker,
  closeoutTitle
} from '../utils/spec-closeout';

const SPEC_MARKDOWN = `---
id: SPEC-PRD-0099-P1
prd: PRD-0099
phase: 1
status: Approved # Draft | Approved | Done | Superseded
date: 2026-08-04
owner: Russ Watson
envelope:
  allowedPaths: ['src/**']
  forbiddenSurfaces: ['ci-config']
  maxDiffLines: 1000
  budgetK: 200
---

# SPEC-PRD-0099-P1: do the thing

## Context

Prose a human wrote. Status: Approved is mentioned here on purpose.

## Task T-01: First task

- **Story:** S-01
- **Complexity:** M
- **Depends on:** []

Engineering notes with a list a human cares about:

- [ ] not an acceptance criterion — a note the author wrote

### Acceptance criteria

- [ ] test: the thing builds
- [ ] agent: the sandbox serves it

## Task T-02: Second task

- **Story:** S-01
- **Complexity:** S
- **Depends on:** [T-01]

### Acceptance criteria

- [ ] test: the other thing
- [ ] manual: a human signs off
`;

const criterion = (
  over: Partial<CloseoutCriterion> &
    Pick<CloseoutCriterion, 'criterionId' | 'taskId' | 'criterion'>
): CloseoutCriterion => ({
  gate: 'verification',
  index: Number(over.criterionId.split('#')[1]),
  tier: 'test',
  coverage: 'pass',
  ...over
});

const CRITERIA: CloseoutCriterion[] = [
  criterion({
    criterionId: 'T-01#1',
    taskId: 'T-01',
    criterion: 'test: the thing builds',
    evidenceLink: 'runs://run-7/evidence/T-01-test-output'
  }),
  criterion({
    criterionId: 'T-01#2',
    taskId: 'T-01',
    criterion: 'agent: the sandbox serves it',
    tier: 'agent',
    coverage: 'fail',
    evidenceLink: 'runs://run-7/evidence/T-01-agent-criterion-2'
  }),
  criterion({
    criterionId: 'T-02#1',
    taskId: 'T-02',
    criterion: 'test: the other thing',
    coverage: 'no-verdict'
  }),
  criterion({
    criterionId: 'T-02#2',
    taskId: 'T-02',
    criterion: 'manual: a human signs off',
    tier: 'manual',
    coverage: 'human-required'
  })
];

const aggregateOf = (
  over: Partial<CloseoutAggregate> = {}
): CloseoutAggregate => ({
  runId: 'run-7',
  specId: 'SPEC-PRD-0099-P1',
  criteria: CRITERIA,
  taskGates: [
    {
      taskId: 'T-01',
      gate: 'phase',
      outcome: 'pass',
      evidenceLinks: [],
      recordedAt: 'x'
    }
  ],
  taskIds: ['T-01', 'T-02'],
  mergedTaskIds: ['T-01', 'T-02'],
  phasePassedTaskIds: ['T-01', 'T-02'],
  fullyCovered: false,
  ...over
});

const allPassing = (over: Partial<CloseoutAggregate> = {}): CloseoutAggregate =>
  aggregateOf({
    criteria: CRITERIA.map(item => ({ ...item, coverage: 'pass' })),
    fullyCovered: true,
    ...over
  });

const criteriaLines = (markdown: string): string[] =>
  markdown
    .split('\n')
    .filter(line => /^- \[[ x]\] (test|agent|manual):/.test(line));

describe('applyCloseout — derived checkboxes (SPEC-PRD-0023-P1 T-02)', () => {
  it('ticks exactly the criteria with a passing verdict', () => {
    const edit = applyCloseout(SPEC_MARKDOWN, aggregateOf());

    expect(criteriaLines(edit.markdown)).toEqual([
      '- [x] test: the thing builds',
      '- [ ] agent: the sandbox serves it',
      '- [ ] test: the other thing',
      '- [ ] manual: a human signs off'
    ]);
    expect(edit.ticked.map(item => item.criterionId)).toEqual(['T-01#1']);
    expect(edit.changed).toBe(true);
  });

  it('leaves criteria without a passing verdict unchecked and in the remainder', () => {
    const edit = applyCloseout(SPEC_MARKDOWN, aggregateOf());

    expect(edit.remainder.map(item => item.criterionId)).toEqual([
      'T-01#2',
      'T-02#1',
      'T-02#2'
    ]);
  });

  it('counts criteria per task, so the second task starts at index one', () => {
    const edit = applyCloseout(
      SPEC_MARKDOWN,
      aggregateOf({
        criteria: CRITERIA.map(item =>
          item.criterionId === 'T-02#1'
            ? { ...item, coverage: 'pass' }
            : { ...item, coverage: 'fail' }
        )
      })
    );

    expect(criteriaLines(edit.markdown)).toEqual([
      '- [ ] test: the thing builds',
      '- [ ] agent: the sandbox serves it',
      '- [x] test: the other thing',
      '- [ ] manual: a human signs off'
    ]);
  });

  it('never touches a checkbox outside an acceptance-criteria section', () => {
    const edit = applyCloseout(SPEC_MARKDOWN, allPassing());

    expect(edit.markdown).toContain(
      '- [ ] not an acceptance criterion — a note the author wrote'
    );
  });

  it('preserves every other line of the document verbatim', () => {
    const edit = applyCloseout(SPEC_MARKDOWN, aggregateOf());
    const before = SPEC_MARKDOWN.split('\n');
    const after = edit.markdown.split('\n');

    expect(after).toHaveLength(before.length);
    const differing = after.filter((line, i) => line !== before[i]);
    expect(differing).toEqual(['- [x] test: the thing builds']);
  });

  it('is idempotent — re-deriving the same coverage changes nothing', () => {
    const once = applyCloseout(SPEC_MARKDOWN, aggregateOf());
    const twice = applyCloseout(once.markdown, aggregateOf());

    expect(twice.markdown).toBe(once.markdown);
    expect(twice.changed).toBe(false);
    expect(twice.ticked).toEqual([]);
  });

  it('leaves a hand-ticked box ticked and reports it as unverified', () => {
    const handTicked = SPEC_MARKDOWN.replace(
      '- [ ] manual: a human signs off',
      '- [x] manual: a human signs off'
    );

    const edit = applyCloseout(handTicked, aggregateOf());

    // Deliberate: derivation only ever adds ticks. A human tick is the record
    // of a human verification and no other artifact holds it.
    expect(edit.markdown).toContain('- [x] manual: a human signs off');
    expect(edit.unverifiedTicks.map(item => item.criterionId)).toEqual([
      'T-02#2'
    ]);
    // It still counts as outstanding, so it cannot buy a status it never earned.
    expect(edit.remainder.map(item => item.criterionId)).toContain('T-02#2');
  });

  it('ignores a checkbox the aggregate has never heard of', () => {
    const drifted = `${SPEC_MARKDOWN}\n- [ ] test: added to the spec after the run parsed it\n`;

    const edit = applyCloseout(drifted, aggregateOf());

    expect(edit.markdown).toContain(
      '- [ ] test: added to the spec after the run parsed it'
    );
  });

  it('stops counting criteria at the next top-level section', () => {
    const trailing = `${SPEC_MARKDOWN}\n## Notes\n\n- [ ] test: not a criterion at all\n`;

    const edit = applyCloseout(trailing, allPassing());

    expect(edit.markdown).toContain('- [ ] test: not a criterion at all');
  });
});

describe('applyCloseout — status roll-up (SPEC-PRD-0023-P1 T-03)', () => {
  it('writes status: Done on full coverage, keeping the template comment', () => {
    const edit = applyCloseout(SPEC_MARKDOWN, allPassing());

    expect(edit.statusWritten).toBe('Done');
    expect(edit.markdown).toContain(
      'status: Done # Draft | Approved | Done | Superseded'
    );
    expect(edit.markdown).not.toContain('status: Approved #');
  });

  it('leaves the prior status untouched on partial coverage', () => {
    const edit = applyCloseout(SPEC_MARKDOWN, aggregateOf());

    expect(edit.statusWritten).toBeUndefined();
    expect(edit.markdown).toContain(
      'status: Approved # Draft | Approved | Done | Superseded'
    );
  });

  it('never rewrites a status: line outside the frontmatter', () => {
    const edit = applyCloseout(SPEC_MARKDOWN, allPassing());

    expect(edit.markdown).toContain(
      'Prose a human wrote. Status: Approved is mentioned here on purpose.'
    );
  });

  it('reports no status write when the spec is already Done', () => {
    const done = SPEC_MARKDOWN.replace('status: Approved', 'status: Done');

    const edit = applyCloseout(done, allPassing());

    expect(edit.statusWritten).toBeUndefined();
    expect(edit.markdown).toContain('status: Done');
  });

  it('writes a status with no trailing comment cleanly', () => {
    const bare = SPEC_MARKDOWN.replace(
      'status: Approved # Draft | Approved | Done | Superseded',
      'status: Approved'
    );

    const edit = applyCloseout(bare, allPassing());

    expect(edit.markdown).toContain('\nstatus: Done\n');
  });

  it('leaves a document with no frontmatter alone', () => {
    const edit = applyCloseout('# just a heading\n', allPassing());

    expect(edit.statusWritten).toBeUndefined();
    expect(edit.changed).toBe(false);
  });

  it('leaves frontmatter with no status field alone', () => {
    const edit = applyCloseout(
      '---\nid: SPEC-X\n---\n\n# body\n',
      allPassing()
    );

    expect(edit.statusWritten).toBeUndefined();
    expect(edit.changed).toBe(false);
  });
});

describe('closeout PR identity and body', () => {
  it('keys the PR on the spec, not the run', () => {
    expect(closeoutBranch('SPEC-PRD-0099-P1')).toBe(
      'sdlc/closeout/SPEC-PRD-0099-P1'
    );
    expect(closeoutTitle('SPEC-PRD-0099-P1')).toContain('SPEC-PRD-0099-P1');
    expect(closeoutMarker('SPEC-PRD-0099-P1')).toBe(
      '<!-- sdlc-closeout: SPEC-PRD-0099-P1 -->'
    );
  });

  it('cites task, gate and evidence for every ticked criterion', () => {
    const aggregate = aggregateOf();
    const body = closeoutBody({
      specId: aggregate.specId,
      runId: aggregate.runId,
      specRelPath: 'specs/PRD-0099/phase-1-spec.md',
      aggregate,
      edit: applyCloseout(SPEC_MARKDOWN, aggregate)
    });

    expect(body).toContain(closeoutMarker('SPEC-PRD-0099-P1'));
    expect(body).toContain(
      '| T-01#1 test: the thing builds | T-01 | verification ' +
        '| `runs://run-7/evidence/T-01-test-output` |'
    );
  });

  it('lists everything outstanding under a Remainder section with its reason', () => {
    const aggregate = aggregateOf();
    const body = closeoutBody({
      specId: aggregate.specId,
      runId: aggregate.runId,
      specRelPath: 'specs/PRD-0099/phase-1-spec.md',
      aggregate,
      edit: applyCloseout(SPEC_MARKDOWN, aggregate)
    });

    const remainder = body.slice(body.indexOf('## Remainder'));
    expect(remainder).toContain(
      '`T-01#2` agent: the sandbox serves it — verdict: fail'
    );
    expect(remainder).toContain(
      '`T-02#1` test: the other thing — no verdict recorded'
    );
    expect(remainder).toContain(
      '`T-02#2` manual: a human signs off — manual-tier, human verification required'
    );
    // A dropped criterion is the failure mode this section exists to prevent.
    expect(remainder.match(/^- `/gm)).toHaveLength(3);
  });

  it('names the phase-level gaps that withhold Done even with every criterion passing', () => {
    // A real closeout hit this: all criteria green, status still withheld, and
    // a Remainder that said "nothing outstanding" — which reads as a generator
    // bug rather than as a task that never merged.
    const aggregate = allPassing({
      mergedTaskIds: ['T-01'],
      phasePassedTaskIds: [],
      fullyCovered: false
    });
    const body = closeoutBody({
      specId: aggregate.specId,
      runId: aggregate.runId,
      specRelPath: 'specs/PRD-0099/phase-1-spec.md',
      aggregate,
      edit: applyCloseout(SPEC_MARKDOWN, aggregate)
    });

    const remainder = body.slice(body.indexOf('## Remainder'));
    expect(remainder).not.toContain('Nothing outstanding');
    expect(remainder).toContain('Tasks with no merge commit recorded: `T-02`.');
    expect(remainder).toContain(
      'Tasks with no passing or stood phase gate: `T-01`, `T-02`.'
    );
    expect(body).toContain('left unchanged (coverage incomplete)');
  });

  it('says so plainly when there is nothing outstanding', () => {
    const aggregate = allPassing();
    const body = closeoutBody({
      specId: aggregate.specId,
      runId: aggregate.runId,
      specRelPath: 'specs/PRD-0099/phase-1-spec.md',
      aggregate,
      edit: applyCloseout(SPEC_MARKDOWN, aggregate)
    });

    expect(body).toContain('Nothing outstanding — full verdict coverage.');
    expect(body).toContain('written as `Done`');
    expect(body).toContain('Criteria passing: 4/4');
  });

  it('reports no verified criteria without pretending otherwise', () => {
    const aggregate = aggregateOf({
      criteria: CRITERIA.map(item => ({ ...item, coverage: 'fail' as const }))
    });
    const body = closeoutBody({
      specId: aggregate.specId,
      runId: aggregate.runId,
      specRelPath: 'specs/PRD-0099/phase-1-spec.md',
      aggregate,
      edit: applyCloseout(SPEC_MARKDOWN, aggregate)
    });

    expect(body).toContain(
      'None — no criterion in this spec has a passing verdict.'
    );
    expect(body).toContain('left unchanged (coverage incomplete)');
  });

  it('surfaces pre-existing ticks in their own section', () => {
    const handTicked = SPEC_MARKDOWN.replace(
      '- [ ] manual: a human signs off',
      '- [x] manual: a human signs off'
    );
    const aggregate = aggregateOf();
    const body = closeoutBody({
      specId: aggregate.specId,
      runId: aggregate.runId,
      specRelPath: 'specs/PRD-0099/phase-1-spec.md',
      aggregate,
      edit: applyCloseout(handTicked, aggregate)
    });

    expect(body).toContain('## Pre-existing ticks left alone');
    expect(body).toContain('`T-02#2` manual: a human signs off');
  });

  it('escapes a pipe in a criterion so the table survives it', () => {
    const aggregate = aggregateOf({
      criteria: [
        criterion({
          criterionId: 'T-01#1',
          taskId: 'T-01',
          criterion: 'test: handles a | b'
        })
      ]
    });
    const body = closeoutBody({
      specId: aggregate.specId,
      runId: aggregate.runId,
      specRelPath: 'specs/PRD-0099/phase-1-spec.md',
      aggregate,
      edit: applyCloseout(SPEC_MARKDOWN, aggregate)
    });

    expect(body).toContain('test: handles a \\| b');
  });

  it('names a ticked criterion with no evidence rather than faking a link', () => {
    const aggregate = aggregateOf({
      criteria: [
        criterion({
          criterionId: 'T-01#1',
          taskId: 'T-01',
          criterion: 'test: the thing builds'
        })
      ]
    });
    const body = closeoutBody({
      specId: aggregate.specId,
      runId: aggregate.runId,
      specRelPath: 'specs/PRD-0099/phase-1-spec.md',
      aggregate,
      edit: applyCloseout(SPEC_MARKDOWN, aggregate)
    });

    expect(body).toContain('_none recorded_');
  });
});
