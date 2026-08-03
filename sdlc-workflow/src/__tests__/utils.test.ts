import { WorkflowError } from '../types';
import { extractJson, validateJson } from '../utils/json-schema';
import { parsePrd } from '../utils/prd-parser';
import { renderSpec } from '../utils/spec-render';
import { validateSpec } from '../utils/spec-validate';
import { makeEnvelope, makeTask, PRD_FIXTURE } from './fixtures';

describe('validateJson', () => {
  it('validates nested objects, arrays, enums, and minItems', () => {
    const schema = {
      type: 'object' as const,
      required: ['items', 'kind'],
      properties: {
        items: {
          type: 'array' as const,
          minItems: 2,
          items: { type: 'number' as const }
        },
        kind: { type: 'string' as const, enum: ['a', 'b'] }
      }
    };

    expect(validateJson(schema, { items: [1, 2], kind: 'a' })).toEqual([]);
    expect(validateJson(schema, { items: [1], kind: 'c' })).toEqual([
      '$.items: expected at least 2 items, got 1',
      '$.kind: value "c" not in [a, b]'
    ]);
    expect(validateJson(schema, { kind: 'a' })).toEqual([
      '$.items: missing required property'
    ]);
    expect(validateJson(schema, [])).toEqual(['$: expected object, got array']);
    expect(validateJson(schema, { items: ['x', 2], kind: 'a' })).toEqual([
      '$.items[0]: expected number, got string'
    ]);
  });
});

describe('extractJson', () => {
  it('parses bare, fenced, and prose-wrapped JSON', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('Here you go: {"a":1} — enjoy')).toEqual({ a: 1 });
  });

  it('throws when no JSON object is present', () => {
    expect(() => extractJson('nothing here')).toThrow('no JSON object');
  });
});

describe('parsePrd', () => {
  it('throws typed errors for malformed input', () => {
    expect(() => parsePrd('# no frontmatter')).toThrow(WorkflowError);
    expect(() => parsePrd('---\nowner: x\n---\n')).toThrow(
      expect.objectContaining({ code: 'PRD_MALFORMED' })
    );
  });

  it('tolerates a PRD without rollout phases or sections', () => {
    const prd = parsePrd('---\nid: PRD-0001\ntitle: Bare\n---\n# Bare\n');
    expect(prd.goals).toEqual([]);
    expect(prd.rolloutPhases).toEqual([]);
    expect(prd.status).toBe('Draft');
  });

  it('parses the full fixture', () => {
    const prd = parsePrd(PRD_FIXTURE);
    expect(prd.rolloutPhases).toHaveLength(2);
    expect(prd.goals).toHaveLength(2);
  });
});

describe('validateSpec', () => {
  it('accepts a well-formed spec', () => {
    expect(validateSpec([makeTask()], makeEnvelope())).toEqual([]);
  });

  it('collects all violations', () => {
    const errors = validateSpec(
      [
        makeTask({ acceptanceCriteria: [] }),
        makeTask({
          id: 'T-02',
          dependsOn: ['T-09'],
          acceptanceCriteria: ['untagged criterion', 'manual: ok']
        })
      ],
      makeEnvelope({ allowedPaths: [], maxDiffLines: 0, budgetK: -1 })
    );

    expect(errors).toEqual([
      'Task T-01: no acceptance criteria',
      'Task T-02: criterion "untagged criterion" is missing a verification-tier tag (test: | agent: | manual:)',
      'Task T-02: depends on unknown task "T-09"',
      'envelope: allowedPaths must not be empty',
      'envelope: maxDiffLines must be a positive number',
      'envelope: budgetK must be a positive number'
    ]);
  });

  it('rejects an empty task list', () => {
    expect(validateSpec([], makeEnvelope())).toContain(
      'spec contains no tasks'
    );
  });

  describe('forbiddenSurfaces resolution', () => {
    // The envelope gate treats an unresolvable label as a breach, so an
    // undefined label silently dooms every task in the spec. It is only
    // catchable here, where the repo's surface map is known.
    it('rejects a label the repo does not define', () => {
      const errors = validateSpec(
        [makeTask()],
        makeEnvelope({ forbiddenSurfaces: ['auth', 'migrations'] }),
        ['auth', 'ci-config']
      );

      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain('"migrations"');
      expect(errors[0]).toContain('defined: auth, ci-config');
    });

    it('accepts labels that all resolve', () => {
      expect(
        validateSpec(
          [makeTask()],
          makeEnvelope({ forbiddenSurfaces: ['auth'] }),
          ['auth']
        )
      ).toEqual([]);
    });

    it('reports "none" when the repo defines no surfaces at all', () => {
      const errors = validateSpec(
        [makeTask()],
        makeEnvelope({ forbiddenSurfaces: ['auth'] }),
        []
      );

      expect(errors[0]).toContain('defined: none');
    });

    // Callers without repo context (pure format checks) must stay unaffected.
    it('skips the check when no surface list is supplied', () => {
      expect(
        validateSpec(
          [makeTask()],
          makeEnvelope({ forbiddenSurfaces: ['does-not-exist'] })
        )
      ).toEqual([]);
    });
  });
});

describe('renderSpec', () => {
  it('renders frontmatter, context, and tasks', () => {
    const md = renderSpec({
      specId: 'SPEC-PRD-0099-P1',
      prdId: 'PRD-0099',
      phase: 1,
      owner: 'Russ Watson',
      date: '2026-07-31',
      summary: 'Walk phase',
      context: 'Context here.',
      tasks: [makeTask()],
      envelope: makeEnvelope()
    });

    expect(md).toMatch(/^---\n/);
    expect(md).toContain('status: Draft');
    expect(md).toContain('# SPEC-PRD-0099-P1: Walk phase');
    expect(md).toContain('## Context');
    expect(md).toContain('## Task T-01: Build the thing');
    expect(md).toContain('- [ ] test: the thing builds');
  });
});
