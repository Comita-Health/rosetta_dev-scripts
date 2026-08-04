import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCommitMessage,
  filterSpecPaths,
  flipDraftStatus,
  isSpecPath,
  planFlip
} from './flip-spec-status.mjs';

const DRAFT = `---
id: SPEC-BUG-example-P1
status: Draft # Draft | Approved | Done | Superseded
owner: Russ
---

# Title
body
`;

describe('spec path filter', () => {
  it('matches specs/**/phase-*-spec.md and rejects others', () => {
    assert.equal(isSpecPath('specs/BUG-x/phase-1-spec.md'), true);
    assert.equal(isSpecPath('specs/a/b/phase-2-spec.md'), true);
    assert.equal(isSpecPath('team-setup/docs/foo.md'), false);
    assert.equal(isSpecPath('specs/BUG-x/README.md'), false);
    assert.deepEqual(filterSpecPaths(['README.md', 'src/x.ts']), []);
  });
});

describe('flipDraftStatus', () => {
  it('rewrites only the status value; other lines byte-identical; idempotent on Approved', () => {
    const { content, changed } = flipDraftStatus(DRAFT);
    assert.equal(changed, true);
    assert.equal(
      content.includes(
        'status: Approved # Draft | Approved | Done | Superseded'
      ),
      true
    );
    const before = DRAFT.split('\n');
    const after = content.split('\n');
    assert.equal(before.length, after.length);
    for (let i = 0; i < before.length; i++) {
      if (before[i].startsWith('status:')) {
        assert.equal(
          after[i],
          'status: Approved # Draft | Approved | Done | Superseded'
        );
      } else {
        assert.equal(after[i], before[i]);
      }
    }
    const approved = DRAFT.replace('status: Draft #', 'status: Approved #');
    assert.equal(flipDraftStatus(approved).changed, false);
    assert.equal(flipDraftStatus(approved).content, approved);
    assert.equal(flipDraftStatus(content).changed, false);
  });
});

describe('planFlip', () => {
  it('noops without phase-*-spec.md paths (no flip commit)', () => {
    assert.deepEqual(
      planFlip(['src/foo.ts'], () => {
        throw new Error('must not read');
      }),
      { action: 'noop', reason: 'no-spec-paths' }
    );
  });

  it('plans a commit for Draft specs and noops when already Approved', () => {
    const approved = DRAFT.replace('status: Draft #', 'status: Approved #');
    assert.deepEqual(
      planFlip(['specs/x/phase-1-spec.md'], () => approved),
      {
        action: 'noop',
        reason: 'already-approved'
      }
    );
    const plan = planFlip(
      ['README.md', 'specs/BUG-example/phase-1-spec.md'],
      p => {
        assert.equal(p, 'specs/BUG-example/phase-1-spec.md');
        return DRAFT;
      }
    );
    assert.equal(plan.action, 'commit');
    if (plan.action === 'commit') {
      assert.equal(plan.flips.length, 1);
      assert.equal(
        plan.message,
        'docs(spec): approve SPEC-BUG-example-P1 on human Approve'
      );
      assert.equal(plan.message, buildCommitMessage(plan.flips));
    }
  });
});
