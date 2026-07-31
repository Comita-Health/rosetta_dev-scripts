import { Envelope, SpecTask } from '../types';

export interface SpecRenderInput {
  specId: string;
  prdId: string;
  phase: number;
  owner: string;
  date: string; // YYYY-MM-DD
  summary: string;
  context: string;
  tasks: SpecTask[];
  envelope: Envelope;
}

const yamlStringArray = (values: string[]): string =>
  `[${values.map(v => JSON.stringify(v)).join(', ')}]`;

const renderTask = (task: SpecTask): string => {
  const lines = [
    `## Task ${task.id}: ${task.title}`,
    '',
    `- **Story:** ${task.storyId}`,
    `- **Complexity:** ${task.complexity}`,
    `- **Depends on:** [${task.dependsOn.join(', ')}]`,
    '',
    task.engineeringNotes,
    '',
    '### Acceptance criteria',
    '',
    ...task.acceptanceCriteria.map(c => `- [ ] ${c}`)
  ];
  return lines.join('\n');
};

/** Render an ADR-0008 implementation spec (status: Draft) as Markdown. */
export const renderSpec = (input: SpecRenderInput): string => {
  const frontmatter = [
    '---',
    `id: ${input.specId}`,
    `prd: ${input.prdId}`,
    `phase: ${input.phase}`,
    'status: Draft # Draft | Approved | Done | Superseded',
    `date: ${input.date}`,
    `owner: ${input.owner}`,
    'envelope:',
    `  allowedPaths: ${yamlStringArray(input.envelope.allowedPaths)}`,
    `  forbiddenSurfaces: ${yamlStringArray(input.envelope.forbiddenSurfaces)}`,
    `  maxDiffLines: ${input.envelope.maxDiffLines}`,
    `  budgetK: ${input.envelope.budgetK}`,
    '---'
  ].join('\n');

  const header = [
    `# ${input.specId}: ${input.summary}`,
    '',
    '## Context',
    '',
    input.context
  ].join('\n');

  const tasks = input.tasks.map(renderTask).join('\n\n');

  return `${frontmatter}\n\n${header}\n\n${tasks}\n`;
};
