import { ReviewChecklist, WorkflowError } from '../types';

/**
 * Parses the repo-owned `.sdlc/review-checklist.md` contract (T-01): a flat
 * markdown checkbox list, one item per line; a trailing `(mandatory)`
 * marker (case-insensitive) is a hard bar. Non-checkbox lines are ignored.
 * Fails loud with `CONTRACT_MALFORMED` on an empty item or zero items —
 * only a missing *file* resolves to null, at the repository layer.
 */
const CHECKBOX_LINE = /^\s*[-*]\s*\[[ xX]\]\s*(.*)$/;
const MANDATORY_SUFFIX = /\s*\(mandatory\)\s*$/i;

export const parseReviewChecklist = (markdown: string): ReviewChecklist => {
  const items: ReviewChecklist['items'] = [];

  for (const line of markdown.split('\n')) {
    const match = line.match(CHECKBOX_LINE);
    if (!match) continue;

    const raw = match[1].trim();
    if (raw.length === 0) {
      throw new WorkflowError(
        'Review checklist has a checkbox item with no text',
        'CONTRACT_MALFORMED'
      );
    }

    const mandatory = MANDATORY_SUFFIX.test(raw);
    const text = raw.replace(MANDATORY_SUFFIX, '').trim();
    items.push({ text, mandatory });
  }

  if (items.length === 0) {
    throw new WorkflowError(
      'Review checklist file contains no checkbox items (expected "- [ ] ..." lines)',
      'CONTRACT_MALFORMED'
    );
  }

  return { items };
};
