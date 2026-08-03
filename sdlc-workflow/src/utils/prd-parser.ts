import { ParsedPrd, PrdRolloutPhase, WorkflowError } from '../types';

const TEMPLATE_POINTER =
  'see rosetta_docs/product/TEMPLATE.md for the exact heading text and numbering required';

const parseFrontmatter = (markdown: string): Record<string, string> => {
  const match = markdown.match(/^---\n([\s\S]*?)\n---/);
  if (!match) {
    throw new WorkflowError('PRD is missing YAML frontmatter', 'PRD_MALFORMED');
  }
  const fields: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    const kv = line.match(/^([A-Za-z_]+):\s*(.*)$/);
    if (kv) {
      fields[kv[1]] = kv[2].replace(/\s*#.*$/, '').trim();
    }
  }
  return fields;
};

/**
 * Bullet items ("- ...") under a heading, up to the next heading.
 *
 * Throws `PRD_MALFORMED` when `required` is true and the heading itself
 * cannot be found — a missing heading almost always means the author (human
 * or agent) drifted from TEMPLATE.md's exact wording/numbering, and doing so
 * previously degraded silently into an empty array here with no signal until
 * a much later, harder-to-diagnose failure downstream (e.g. decompose's
 * "no goals" error, which doesn't explain that the real cause is a heading
 * mismatch). A heading that *is* found but has zero bullets under it is a
 * legitimate content choice (e.g. no non-goals) and is not an error.
 */
const sectionBullets = (
  markdown: string,
  headingPattern: RegExp,
  sectionLabel: string,
  required: boolean
): string[] => {
  const headingMatch = markdown.match(headingPattern);
  if (!headingMatch || headingMatch.index === undefined) {
    if (required) {
      throw new WorkflowError(
        `PRD is missing the "${sectionLabel}" section`,
        'PRD_MALFORMED',
        [
          `expected a heading matching ${headingPattern} — ${TEMPLATE_POINTER}`
        ]
      );
    }
    return [];
  }
  const rest = markdown.slice(headingMatch.index + headingMatch[0].length);
  const nextHeading = rest.search(/\n#{2,3}\s/);
  const body = nextHeading === -1 ? rest : rest.slice(0, nextHeading);

  const bullets: string[] = [];
  let current: string | null = null;
  for (const line of body.split('\n')) {
    const bullet = line.match(/^- (?:\[[ x]\] )?(.*)$/);
    if (bullet) {
      if (current !== null) bullets.push(current);
      current = bullet[1].trim();
    } else if (current !== null && /^\s+\S/.test(line)) {
      current += ` ${line.trim()}`;
    } else if (current !== null) {
      bullets.push(current);
      current = null;
    }
  }
  if (current !== null) bullets.push(current);
  return bullets;
};

/**
 * Extracts one phase's number/title/description from a single numbered
 * bullet's raw text. Deliberately tolerant of the markdown variations that
 * show up across real PRDs in this repo (title inside vs. outside the bold
 * span, an em dash vs. a hyphen, an optional status marker like an emoji
 * before "**Phase") — none of that variation changes what a phase *is*.
 * Returns `undefined` when the bullet doesn't reference a phase at all, so
 * the caller can skip stray non-phase bullets without erroring.
 */
const parsePhaseBullet = (bulletText: string): PrdRolloutPhase | undefined => {
  const phaseNumMatch = bulletText.match(/Phase\s+(\d+)/);
  if (!phaseNumMatch || phaseNumMatch.index === undefined) return undefined;

  const afterPhaseNum = bulletText
    .slice(phaseNumMatch.index + phaseNumMatch[0].length)
    .replace(/\*\*/g, '');
  const separator = afterPhaseNum.match(/^\s*[—-]\s*/);
  if (!separator) return undefined;

  const rest = afterPhaseNum.slice(separator[0].length).trim();
  const colonIdx = rest.indexOf(':');
  const title = (colonIdx === -1 ? rest : rest.slice(0, colonIdx)).trim();
  const description = (colonIdx === -1 ? '' : rest.slice(colonIdx + 1)).trim();
  return { number: Number(phaseNumMatch[1]), title, description };
};

const parseRolloutPhases = (markdown: string): PrdRolloutPhase[] => {
  const headingMatch = markdown.match(/\n## .*Rollout.*\n/);
  if (!headingMatch || headingMatch.index === undefined) {
    throw new WorkflowError('PRD is missing the "Rollout & Phases" section', 'PRD_MALFORMED', [
      `expected a heading matching /## .*Rollout.*/ (e.g. "## 7. Rollout & Phases") — ${TEMPLATE_POINTER}`
    ]);
  }
  const rest = markdown.slice(headingMatch.index + headingMatch[0].length);
  const nextHeading = rest.search(/\n## /);
  const body = nextHeading === -1 ? rest : rest.slice(0, nextHeading);

  // Slice explicitly between consecutive top-level bullet starts rather than
  // using a lazy `[\s\S]*?` bounded by a `\s*$` lookahead: `$` in multiline
  // mode matches before *every* line's `\n`, so a lookahead-bounded lazy
  // match stops at the end of a phase's first wrapped line instead of its
  // true end — silently truncating (or entirely dropping) any phase whose
  // description wraps across multiple lines, exactly the failure mode this
  // parser exists to eliminate.
  const bulletStarts = [...body.matchAll(/^\d+\.\s+/gm)];
  const phases: PrdRolloutPhase[] = [];
  for (let i = 0; i < bulletStarts.length; i++) {
    const start = bulletStarts[i].index + bulletStarts[i][0].length;
    const end =
      i + 1 < bulletStarts.length ? bulletStarts[i + 1].index : body.length;
    const bulletText = body.slice(start, end).replace(/\s+/g, ' ').trim();
    const phase = parsePhaseBullet(bulletText);
    if (phase) phases.push(phase);
  }

  if (phases.length === 0) {
    throw new WorkflowError(
      'PRD has a Rollout heading but no phase items matched the expected format',
      'PRD_MALFORMED',
      [
        'expected numbered items naming "Phase <N>" followed by an em dash' +
          ' (—) or hyphen (-) and a title, e.g.' +
          ' `1. **Phase 1 — <deliverable>**` or `1. **Phase 1** — <deliverable>`' +
          ` — ${TEMPLATE_POINTER}`
      ]
    );
  }
  return phases;
};

export const parsePrd = (markdown: string): ParsedPrd => {
  const fields = parseFrontmatter(markdown);
  if (!fields.id || !fields.title) {
    throw new WorkflowError(
      'PRD frontmatter is missing required fields (id, title)',
      'PRD_MALFORMED'
    );
  }

  return {
    id: fields.id,
    title: fields.title,
    status: fields.status ?? 'Draft',
    owner: fields.owner ?? '',
    goals: sectionBullets(markdown, /###\s+1\.2\s+Goals\s*\n/, '1.2 Goals', true),
    nonGoals: sectionBullets(
      markdown,
      /###\s+1\.3\s+Non-Goals\s*\n/,
      '1.3 Non-Goals',
      false
    ),
    acceptanceCriteria: sectionBullets(
      markdown,
      /###\s+1\.4\s+Acceptance Criteria\s*\n/,
      '1.4 Acceptance Criteria',
      true
    ),
    rolloutPhases: parseRolloutPhases(markdown)
  };
};
