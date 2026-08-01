import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { injectable } from 'inversify';
import path from 'path';

/**
 * Appends items to the PRD-0007 personal work queue —
 * `<chronicleRepo>/chronicles/queue.md`, the existing queue API: a
 * human-editable Markdown file of tagged checkbox lines under section
 * headings. This repository only appends to Inbox and never modifies the
 * queue schema (`personal-queue-schema` is a forbidden surface).
 */
export interface IQueueRepository {
  /**
   * Append one checkbox item to the Inbox section. Idempotent by title: an
   * item whose title already appears anywhere in the file is skipped.
   * Returns true when a line was actually appended.
   */
  appendItem(chronicleRepo: string, title: string, tags: string[]): boolean;
}

const QUEUE_PATH = path.join('chronicles', 'queue.md');

const EMPTY_QUEUE = [
  '# Work Queue',
  '',
  '_Your personal "what\'s next?" list. Edit freely — tags make items machine-readable._',
  '',
  '## Active',
  '<!-- empty -->',
  '',
  '## Next Up',
  '<!-- empty -->',
  '',
  '## Inbox',
  ''
].join('\n');

@injectable()
export class QueueRepository implements IQueueRepository {
  appendItem(chronicleRepo: string, title: string, tags: string[]): boolean {
    const file = path.join(chronicleRepo, QUEUE_PATH);
    let content: string;
    if (existsSync(file)) {
      content = readFileSync(file, 'utf-8');
    } else {
      mkdirSync(path.dirname(file), { recursive: true });
      content = EMPTY_QUEUE;
    }

    if (content.includes(title)) {
      return false;
    }

    const line = `- [ ] ${title}${tags.length > 0 ? ' ' + tags.map(tag => `[${tag}]`).join(' ') : ''}`;
    const lines = content.split('\n');
    const inboxIndex = lines.findIndex(entry =>
      /^##\s+inbox\s*$/i.test(entry.trim())
    );

    if (inboxIndex === -1) {
      lines.push('', '## Inbox', line);
    } else if (lines[inboxIndex + 1]?.trim() === '<!-- empty -->') {
      lines.splice(inboxIndex + 1, 1, line);
    } else {
      lines.splice(inboxIndex + 1, 0, line);
    }

    writeFileSync(file, lines.join('\n'));
    return true;
  }
}
