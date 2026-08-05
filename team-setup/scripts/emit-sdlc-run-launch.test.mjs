import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  EVENT_TYPE,
  buildClientPayload,
  filterSpecPaths,
  isSpecPath,
  planEmit
} from './emit-sdlc-run-launch.mjs';

describe('spec path filter', () => {
  it('matches specs/**/phase-*-spec.md and rejects others', () => {
    assert.equal(isSpecPath('specs/BUG-x/phase-1-spec.md'), true);
    assert.equal(isSpecPath('specs/a/b/phase-2-spec.md'), true);
    assert.equal(isSpecPath('team-setup/docs/foo.md'), false);
    assert.equal(isSpecPath('specs/BUG-x/README.md'), false);
    assert.deepEqual(filterSpecPaths(['README.md', 'src/x.ts']), []);
  });
});

describe('buildClientPayload', () => {
  it('includes every spec path, the merge SHA, and the PR number', () => {
    assert.deepEqual(
      buildClientPayload({
        specPaths: [
          'specs/BUG-a/phase-1-spec.md',
          'specs/PRD-1/phase-2-spec.md'
        ],
        mergedSha: 'abc123def456',
        prNumber: 42
      }),
      {
        specPaths: [
          'specs/BUG-a/phase-1-spec.md',
          'specs/PRD-1/phase-2-spec.md'
        ],
        mergedSha: 'abc123def456',
        prNumber: 42
      }
    );
  });
});

describe('planEmit', () => {
  it('builds a dispatch plan with every spec path and the merge SHA', () => {
    const plan = planEmit({
      paths: [
        'README.md',
        'specs/BUG-a/phase-1-spec.md',
        'src/x.ts',
        'specs/nested/x/phase-3-spec.md'
      ],
      mergedSha: 'deadbeefcafe',
      prNumber: '99'
    });
    assert.equal(plan.action, 'dispatch');
    if (plan.action === 'dispatch') {
      assert.equal(plan.event_type, EVENT_TYPE);
      assert.deepEqual(plan.client_payload, {
        specPaths: [
          'specs/BUG-a/phase-1-spec.md',
          'specs/nested/x/phase-3-spec.md'
        ],
        mergedSha: 'deadbeefcafe',
        prNumber: 99
      });
    }
  });

  it('noops for non-spec merges (emit nothing)', () => {
    assert.deepEqual(
      planEmit({
        paths: ['team-setup/docs/foo.md', 'src/x.ts'],
        mergedSha: 'abc',
        prNumber: 1
      }),
      { action: 'noop', reason: 'no-spec-paths' }
    );
  });

  it('dedups by merge SHA (exactly once)', () => {
    assert.deepEqual(
      planEmit({
        paths: ['specs/BUG-a/phase-1-spec.md'],
        mergedSha: 'same-sha',
        prNumber: 7,
        emittedShas: ['other', 'same-sha']
      }),
      { action: 'noop', reason: 'already-emitted' }
    );
    const again = planEmit({
      paths: ['specs/BUG-a/phase-1-spec.md'],
      mergedSha: 'same-sha',
      prNumber: 7,
      emittedShas: []
    });
    assert.equal(again.action, 'dispatch');
  });

  it('noops without a merge SHA or with an invalid PR number', () => {
    assert.deepEqual(
      planEmit({
        paths: ['specs/BUG-a/phase-1-spec.md'],
        mergedSha: '  ',
        prNumber: 1
      }),
      { action: 'noop', reason: 'no-merged-sha' }
    );
    assert.deepEqual(
      planEmit({
        paths: ['specs/BUG-a/phase-1-spec.md'],
        mergedSha: 'abc',
        prNumber: 'not-a-number'
      }),
      { action: 'noop', reason: 'invalid-pr-number' }
    );
  });
});
