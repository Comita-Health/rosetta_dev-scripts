import { ParsedPrd, PrdRolloutPhase, WorkflowError } from '../types';

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

/** Bullet items ("- ...") under a heading, up to the next heading. */
const sectionBullets = (markdown: string, headingPattern: RegExp): string[] => {
  const headingMatch = markdown.match(headingPattern);
  if (!headingMatch || headingMatch.index === undefined) return [];
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

const parseRolloutPhases = (markdown: string): PrdRolloutPhase[] => {
  const headingMatch = markdown.match(/\n## .*Rollout.*\n/);
  if (!headingMatch || headingMatch.index === undefined) return [];
  const rest = markdown.slice(headingMatch.index + headingMatch[0].length);
  const nextHeading = rest.search(/\n## /);
  const body = nextHeading === -1 ? rest : rest.slice(0, nextHeading);

  const phases: PrdRolloutPhase[] = [];
  const itemPattern =
    /^\d+\.\s+\*\*Phase (\d+)\s*—\s*([^:*]+):?\*\*:?\s*([\s\S]*?)(?=^\d+\.\s+\*\*|\s*$)/gm;
  let match: RegExpExecArray | null;
  while ((match = itemPattern.exec(body)) !== null) {
    phases.push({
      number: Number(match[1]),
      title: match[2].trim(),
      description: match[3].replace(/\s+/g, ' ').trim()
    });
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
    goals: sectionBullets(markdown, /###\s+1\.2\s+Goals\s*\n/),
    nonGoals: sectionBullets(markdown, /###\s+1\.3\s+Non-Goals\s*\n/),
    acceptanceCriteria: sectionBullets(
      markdown,
      /###\s+1\.4\s+Acceptance Criteria\s*\n/
    ),
    rolloutPhases: parseRolloutPhases(markdown)
  };
};
