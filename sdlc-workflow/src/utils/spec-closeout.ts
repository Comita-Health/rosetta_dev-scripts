import { CloseoutAggregate, CloseoutCriterion, SpecStatus } from '../types';

/**
 * Marker embedded in every closeout PR body. Lookup is by branch name; this
 * exists so a human (or a future cross-repo linker) can recognise a closeout
 * PR from its body alone without parsing the title, which is free text.
 */
export const closeoutMarker = (specId: string): string =>
  `<!-- sdlc-closeout: ${specId} -->`;

/**
 * The stable identifier a closeout PR is found by (SPEC-PRD-0023-P1 T-02).
 * One branch per spec — not per run — so a resumed or relaunched run updates
 * the same PR instead of opening a second one.
 */
export const closeoutBranch = (specId: string): string =>
  `sdlc/closeout/${specId}`;

export const closeoutTitle = (specId: string): string =>
  `docs(${specId}): closeout — acceptance criteria and status from verdicts`;

/** What {@link applyCloseout} changed, and what it deliberately did not. */
export interface CloseoutEdit {
  /** The spec markdown after derivation. Identical to the input when nothing moved. */
  markdown: string;
  /** Criteria this closeout ticked from a passing verdict. */
  ticked: CloseoutCriterion[];
  /**
   * Criteria already ticked in the spec on disk with no passing verdict in
   * this run. Reported, never untied — see {@link applyCloseout}.
   */
  unverifiedTicks: CloseoutCriterion[];
  /** Criteria without a passing verdict, ticked or not. */
  remainder: CloseoutCriterion[];
  /** The status value written, or undefined when status was left untouched. */
  statusWritten?: SpecStatus;
  changed: boolean;
}

const CHECKBOX = /^(\s*- \[)([ x])(\] )(.*)$/;
const TASK_HEADING = /^## Task (T-\d+):/;
const CRITERIA_HEADING = /^### Acceptance criteria\s*$/;

/**
 * Derive a spec's checkbox and `status:` state from a run's recorded verdicts
 * (SPEC-PRD-0023-P1 T-02 / T-03).
 *
 * Pure: takes the spec markdown as it exists on the default branch and
 * returns the closeout version of it. Prose, engineering notes and any
 * hand-written annotation survive untouched — only the checkbox character and
 * the frontmatter status value are ever rewritten, so this is safe to run
 * against a spec a human has been editing.
 *
 * @remarks
 * Two deliberate asymmetries, both in the direction of never destroying
 * evidence:
 *
 * - A box already ticked on disk is **never** unticked, even with no verdict
 *   behind it. A hand tick is a human's record of hand verification (this
 *   engine's own specs were closed out that way), and silently clearing it
 *   would lose information no other artifact holds. Such criteria are
 *   reported as {@link CloseoutEdit.unverifiedTicks} and still count as
 *   remainder, so they cannot buy a `status: Done` they have not earned.
 * - `status:` is only ever written *forward* to `Done`, and only on full
 *   coverage. Partial coverage leaves the prior value exactly as it was —
 *   gaps surface as the remainder list, never as a downgrade.
 */
export const applyCloseout = (
  markdown: string,
  aggregate: CloseoutAggregate
): CloseoutEdit => {
  const byId = new Map(
    aggregate.criteria.map(criterion => [criterion.criterionId, criterion])
  );
  const ticked: CloseoutCriterion[] = [];
  const unverifiedTicks: CloseoutCriterion[] = [];

  const lines = markdown.split('\n');
  const out: string[] = [];
  let taskId: string | null = null;
  let inCriteria = false;
  let index = 0;

  for (const line of lines) {
    const heading = line.match(TASK_HEADING);
    if (heading !== null) {
      taskId = heading[1];
      inCriteria = false;
      index = 0;
      out.push(line);
      continue;
    }
    if (CRITERIA_HEADING.test(line)) {
      inCriteria = true;
      index = 0;
      out.push(line);
      continue;
    }
    if (line.startsWith('## ')) {
      inCriteria = false;
    }

    const box = inCriteria && taskId !== null ? line.match(CHECKBOX) : null;
    if (box === null) {
      out.push(line);
      continue;
    }

    index += 1;
    const criterion = byId.get(`${taskId}#${index}`);
    const wasTicked = box[2] === 'x';
    if (criterion === undefined) {
      // A criterion the aggregate has never heard of means the spec on the
      // default branch has drifted from the one the run parsed. Leave it be:
      // guessing here would tick the wrong box.
      out.push(line);
      continue;
    }
    const shouldTick = criterion.coverage === 'pass';
    if (shouldTick && !wasTicked) ticked.push(criterion);
    if (!shouldTick && wasTicked) unverifiedTicks.push(criterion);
    out.push(
      `${box[1]}${shouldTick || wasTicked ? 'x' : ' '}${box[3]}${box[4]}`
    );
  }

  const withStatus = aggregate.fullyCovered
    ? writeStatusDone(out.join('\n'))
    : { markdown: out.join('\n'), written: false };

  const remainder = aggregate.criteria.filter(
    criterion => criterion.coverage !== 'pass'
  );

  return {
    markdown: withStatus.markdown,
    ticked,
    unverifiedTicks,
    remainder,
    ...(withStatus.written ? { statusWritten: 'Done' as SpecStatus } : {}),
    changed: withStatus.markdown !== markdown
  };
};

/**
 * Rewrite the frontmatter `status:` value to `Done`, preserving any trailing
 * comment (the template ships `status: Approved # Draft | Approved | ...`).
 * Only the first frontmatter block is considered — a `status:` line in prose
 * further down the document is not the spec's status.
 */
const writeStatusDone = (
  markdown: string
): { markdown: string; written: boolean } => {
  const lines = markdown.split('\n');
  if (lines[0] !== '---') return { markdown, written: false };
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i] === '---') break;
    const match = lines[i].match(/^status:\s*(\S+)(\s*#.*)?$/);
    if (match === null) continue;
    if (match[1] === 'Done') return { markdown, written: false };
    lines[i] = `status: Done${match[2] ?? ''}`;
    return { markdown: lines.join('\n'), written: true };
  }
  return { markdown, written: false };
};

const coverageNote = (criterion: CloseoutCriterion): string => {
  if (criterion.coverage === 'no-verdict') return 'no verdict recorded';
  if (criterion.coverage === 'human-required') {
    return `${criterion.tier}-tier, human verification required`;
  }
  return 'verdict: fail';
};

export interface CloseoutBodyInput {
  specId: string;
  runId: string;
  /** Repo-relative path of the spec the PR edits. */
  specRelPath: string;
  aggregate: CloseoutAggregate;
  edit: CloseoutEdit;
}

/**
 * Render the closeout PR body: every ticked criterion cited by (task, gate,
 * evidence link), and everything still outstanding under a Remainder section.
 *
 * @remarks
 * There is no free-text authoring surface here on purpose — the body is a
 * rendering of {@link CloseoutAggregate}, so what a reviewer reads is exactly
 * what the run recorded. The citation is the point: a ticked box whose
 * evidence link cannot be followed is not closeout, it is an assertion.
 */
export const closeoutBody = (input: CloseoutBodyInput): string => {
  const { aggregate, edit } = input;
  const passing = aggregate.criteria.filter(
    criterion => criterion.coverage === 'pass'
  );

  const lines: string[] = [
    closeoutMarker(input.specId),
    '',
    '## Summary',
    '',
    `Closeout for \`${input.specId}\` — every checkbox and the \`status:\` field ` +
      `below are derived from the verdicts recorded by run \`${input.runId}\`. ` +
      'Nothing in this PR is hand-authored.',
    '',
    `- Spec: \`${input.specRelPath}\``,
    `- Criteria passing: ${passing.length}/${aggregate.criteria.length}`,
    `- Boxes ticked by this closeout: ${edit.ticked.length}`,
    `- Status: ${
      edit.statusWritten === undefined
        ? 'left unchanged (coverage incomplete)'
        : `written as \`${edit.statusWritten}\``
    }`,
    ''
  ];

  lines.push('## Verified criteria', '');
  if (passing.length === 0) {
    lines.push('None — no criterion in this spec has a passing verdict.', '');
  } else {
    lines.push(
      '| Criterion | Task | Gate | Evidence |',
      '| --- | --- | --- | --- |'
    );
    for (const criterion of passing) {
      lines.push(
        `| ${criterion.criterionId} ${criterion.criterion.replace(/\|/g, '\\|')} ` +
          `| ${criterion.taskId} | ${criterion.gate} ` +
          `| ${criterion.evidenceLink === undefined ? '_none recorded_' : `\`${criterion.evidenceLink}\``} |`
      );
    }
    lines.push('');
  }

  const unmerged = aggregate.taskIds.filter(
    taskId => !aggregate.mergedTaskIds.includes(taskId)
  );
  const phaseUnproven = aggregate.taskIds.filter(
    taskId => !aggregate.phasePassedTaskIds.includes(taskId)
  );

  lines.push('## Remainder', '');
  if (
    edit.remainder.length === 0 &&
    unmerged.length === 0 &&
    phaseUnproven.length === 0
  ) {
    lines.push('Nothing outstanding — full verdict coverage.', '');
  } else {
    if (edit.remainder.length > 0) {
      lines.push(
        'Criteria left unchecked, with the reason the run could not verify each:',
        ''
      );
      for (const criterion of edit.remainder) {
        lines.push(
          `- \`${criterion.criterionId}\` ${criterion.criterion} — ${coverageNote(criterion)}`
        );
      }
      lines.push('');
    }
    // Phase-level gaps are why a spec with every criterion passing can still
    // not be Done. Saying "nothing outstanding" next to "status unchanged"
    // reads as a bug in the generator rather than as unfinished work.
    if (unmerged.length > 0) {
      lines.push(
        `Tasks with no merge commit recorded: ${unmerged
          .map(taskId => `\`${taskId}\``)
          .join(', ')}.`,
        ''
      );
    }
    if (phaseUnproven.length > 0) {
      lines.push(
        `Tasks with no passing phase gate: ${phaseUnproven
          .map(taskId => `\`${taskId}\``)
          .join(', ')}.`,
        ''
      );
    }
  }

  if (edit.unverifiedTicks.length > 0) {
    lines.push(
      '## Pre-existing ticks left alone',
      '',
      'These boxes were already ticked in the spec on the default branch and ' +
        'have no passing verdict in this run. Closeout never unticks a box — a ' +
        'hand tick is a human record of hand verification — but they do not ' +
        'count toward `status: Done` either, so they also appear above.',
      ''
    );
    for (const criterion of edit.unverifiedTicks) {
      lines.push(`- \`${criterion.criterionId}\` ${criterion.criterion}`);
    }
    lines.push('');
  }

  const gates = aggregate.taskGates.filter(gate => gate.gate === 'phase');
  lines.push(
    '## Merge evidence',
    '',
    `- Tasks merged: ${aggregate.mergedTaskIds.length}` +
      (aggregate.mergedTaskIds.length > 0
        ? ` (${aggregate.mergedTaskIds.join(', ')})`
        : ''),
    `- Tasks with a green phase gate: ${gates
      .filter(gate => gate.outcome === 'pass')
      .map(gate => gate.taskId)
      .join(', ')}`,
    '',
    `Generated by \`sdlc-workflow\` closeout (SPEC-PRD-0023-P1) from run \`${input.runId}\`.`
  );

  return lines.join('\n');
};
