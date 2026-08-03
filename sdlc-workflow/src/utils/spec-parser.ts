import {
  Complexity,
  Envelope,
  SpecDocument,
  SpecStatus,
  SpecTask,
  WorkflowError
} from '../types';

const SPEC_STATUSES: readonly SpecStatus[] = [
  'Draft',
  'Approved',
  'Done',
  'Superseded'
];

const COMPLEXITIES: readonly Complexity[] = ['S', 'M', 'L'];

/**
 * Split on commas that actually separate elements — not ones inside a quoted
 * string or a brace/bracket group. A naive `split(',')` shreds a brace glob
 * (`**\/*.{test,spec}.ts` becomes two broken halves), which is quietly
 * dangerous in `forbiddenSurfaces`: the surface stops matching anything and
 * the gate that was meant to guard it silently passes.
 */
const splitTopLevel = (inner: string): string[] => {
  const parts: string[] = [];
  let depth = 0;
  let quote: "'" | '"' | null = null;
  let current = '';

  for (const char of inner) {
    if (quote !== null) {
      if (char === quote) quote = null;
      current += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      current += char;
      continue;
    }
    if (char === '{' || char === '[') depth += 1;
    if (char === '}' || char === ']') depth -= 1;
    if (char === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts;
};

/** Parse an inline YAML string array: ["a", "b"] or ['a', 'b']. */
const parseInlineArray = (raw: string): string[] => {
  const inner = raw.trim().replace(/^\[/, '').replace(/\]$/, '').trim();
  if (inner.length === 0) return [];
  return splitTopLevel(inner)
    .map(item => item.trim().replace(/^['"]/, '').replace(/['"]$/, ''))
    .filter(item => item.length > 0);
};

const stripComment = (value: string): string =>
  value.replace(/\s*#.*$/, '').trim();

/** True when `raw` contains a balanced `[...]` array (inline or folded). */
const hasBalancedArray = (raw: string): boolean => {
  const opens = (raw.match(/\[/g) ?? []).length;
  const closes = (raw.match(/\]/g) ?? []).length;
  return opens > 0 && opens === closes;
};

/**
 * Parse YAML frontmatter. Envelope arrays may be inline (`key: ['a']`) or
 * Prettier-folded multiline (`key:\n    [\n      'a',\n    ]`) — both are
 * common after `prettier --write` on `*.md` specs.
 */
const parseFrontmatter = (
  markdown: string
): { fields: Record<string, string>; envelope: Envelope } => {
  const match = markdown.match(/^---\n([\s\S]*?)\n---/);
  if (!match) {
    throw new WorkflowError(
      'Spec is missing YAML frontmatter',
      'SPEC_MALFORMED'
    );
  }

  const fields: Record<string, string> = {};
  const envelopeFields: Record<string, string> = {};
  let inEnvelope = false;
  let collectingKey: string | null = null;
  let collectingBuf = '';

  const flushCollecting = (): void => {
    if (collectingKey === null) return;
    envelopeFields[collectingKey] = stripComment(collectingBuf.trim());
    collectingKey = null;
    collectingBuf = '';
  };

  for (const line of match[1].split('\n')) {
    if (/^envelope:\s*$/.test(line)) {
      flushCollecting();
      inEnvelope = true;
      continue;
    }
    const nested = line.match(/^ {2}([A-Za-z]+):\s*(.*)$/);
    if (inEnvelope && nested) {
      flushCollecting();
      const key = nested[1];
      const rest = stripComment(nested[2]);
      // Prettier may fold arrays as `key:\n    [\n ... ]` (empty rest) or
      // leave an unclosed `[` on the key line. Scalars stay inline.
      if (
        rest.length === 0 ||
        (rest.includes('[') && !hasBalancedArray(rest))
      ) {
        collectingKey = key;
        collectingBuf = rest;
      } else {
        envelopeFields[key] = rest;
      }
      continue;
    }
    if (inEnvelope && collectingKey !== null && /^\s+\S/.test(line)) {
      const piece = stripComment(line.trim());
      if (piece.length === 0) continue;
      collectingBuf =
        collectingBuf.length === 0 ? piece : `${collectingBuf} ${piece}`;
      if (hasBalancedArray(collectingBuf)) {
        flushCollecting();
      }
      continue;
    }
    flushCollecting();
    inEnvelope = false;
    const kv = line.match(/^([A-Za-z_]+):\s*(.*)$/);
    if (kv) {
      fields[kv[1]] = stripComment(kv[2]);
    }
  }
  flushCollecting();

  const required = [
    'allowedPaths',
    'forbiddenSurfaces',
    'maxDiffLines',
    'budgetK'
  ];
  for (const key of required) {
    if (envelopeFields[key] === undefined) {
      throw new WorkflowError(
        `Spec envelope is missing required field "${key}"`,
        'SPEC_MALFORMED'
      );
    }
  }

  const envelope: Envelope = {
    allowedPaths: parseInlineArray(envelopeFields.allowedPaths),
    forbiddenSurfaces: parseInlineArray(envelopeFields.forbiddenSurfaces),
    maxDiffLines: Number(envelopeFields.maxDiffLines),
    budgetK: Number(envelopeFields.budgetK)
  };
  return { fields, envelope };
};

const parseTask = (section: string): SpecTask => {
  const heading = section.match(/^## Task (T-\d+): (.*)$/m);
  if (!heading) {
    throw new WorkflowError(
      'Spec task section is missing its heading',
      'SPEC_MALFORMED'
    );
  }
  const storyId = section.match(/^- \*\*Story:\*\* (\S+)$/m)?.[1] ?? '';
  const complexityRaw =
    section.match(/^- \*\*Complexity:\*\* (\S+)$/m)?.[1] ?? '';
  const dependsRaw = section.match(/^- \*\*Depends on:\*\* \[(.*)\]$/m)?.[1];
  const complexity = COMPLEXITIES.includes(complexityRaw as Complexity)
    ? (complexityRaw as Complexity)
    : 'M';

  const criteriaMatch = section.match(
    /### Acceptance criteria\n\n([\s\S]*?)(?=\n## |$)/
  );
  const criteria: string[] = [];
  if (criteriaMatch) {
    let current: string | null = null;
    for (const line of criteriaMatch[1].split('\n')) {
      const bullet = line.match(/^- \[[ x]\] (.*)$/);
      if (bullet) {
        if (current !== null) criteria.push(current);
        current = bullet[1].trim();
      } else if (current !== null && /^\s+\S/.test(line)) {
        current += ` ${line.trim()}`;
      } else if (current !== null) {
        criteria.push(current);
        current = null;
      }
    }
    if (current !== null) criteria.push(current);
  }

  const notesMatch = section.match(
    /^- \*\*Depends on:\*\*.*\n\n([\s\S]*?)\n\n### Acceptance criteria/m
  );

  return {
    id: heading[1],
    storyId,
    phase: 0, // filled by the caller from frontmatter
    title: heading[2].trim(),
    engineeringNotes: notesMatch ? notesMatch[1].trim() : '',
    complexity,
    dependsOn:
      dependsRaw === undefined || dependsRaw.trim().length === 0
        ? []
        : dependsRaw.split(',').map(id => id.trim()),
    acceptanceCriteria: criteria
  };
};

/**
 * Parse an ADR-0008 implementation spec Markdown document (the round-trip
 * counterpart of `renderSpec`) into a typed `SpecDocument`.
 */
export const parseSpec = (markdown: string): SpecDocument => {
  const { fields, envelope } = parseFrontmatter(markdown);

  for (const key of ['id', 'prd', 'phase', 'status']) {
    if (fields[key] === undefined || fields[key].length === 0) {
      throw new WorkflowError(
        `Spec frontmatter is missing required field "${key}"`,
        'SPEC_MALFORMED'
      );
    }
  }
  if (!SPEC_STATUSES.includes(fields.status as SpecStatus)) {
    throw new WorkflowError(
      `Spec status "${fields.status}" is not one of ${SPEC_STATUSES.join(' | ')}`,
      'SPEC_MALFORMED'
    );
  }

  const phase = Number(fields.phase);
  const sections = markdown.split(/(?=^## Task T-\d+: )/m).slice(1);
  const tasks = sections.map(section => ({ ...parseTask(section), phase }));

  if (tasks.length === 0) {
    throw new WorkflowError('Spec contains no tasks', 'SPEC_MALFORMED');
  }

  return {
    id: fields.id,
    prdId: fields.prd,
    phase,
    status: fields.status as SpecStatus,
    envelope,
    tasks
  };
};
