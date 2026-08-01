import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  mkdirSync
} from 'fs';
import os from 'os';
import path from 'path';
import { QueueRepository } from '../repositories/queue.repository';

const queueFile = (repo: string): string =>
  path.join(repo, 'chronicles', 'queue.md');

/**
 * Minimal reimplementation of the PRD-0007 queue consumer contract:
 * checkbox items under section headings, inline `[tag]`s stripped from the
 * title. Mirrors rosetta_chronicle's parseQueue semantics — the consumer
 * contract this repository's output must satisfy.
 */
const parseItems = (
  markdown: string
): Array<{ title: string; section: string; tags: string[] }> => {
  const items: Array<{ title: string; section: string; tags: string[] }> = [];
  let section = 'inbox';
  for (const line of markdown.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('##')) {
      section = trimmed.replace(/^#+\s*/, '').toLowerCase();
      continue;
    }
    const match = /^-\s*\[[x ]\]\s+(.+)$/i.exec(trimmed);
    if (!match) continue;
    const tags = [...match[1].matchAll(/\[([^\]]+)\]/g)].map(m => m[1]);
    const title = match[1].replace(/\s*\[[^\]]+\]/g, '').trim();
    items.push({ title, section, tags });
  }
  return items;
};

describe('QueueRepository (T-07, PRD-0007 queue file contract)', () => {
  let repo: string;
  const queue = new QueueRepository();

  beforeEach(() => {
    repo = mkdtempSync(path.join(os.tmpdir(), 'sdlc-queue-'));
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it('creates chronicles/queue.md with the item in Inbox when absent', () => {
    const appended = queue.appendItem(repo, 'Review SDLC digest run-1 T-01', [
      'follow-up'
    ]);

    expect(appended).toBe(true);
    expect(existsSync(queueFile(repo))).toBe(true);
    const items = parseItems(readFileSync(queueFile(repo), 'utf-8'));
    expect(items).toEqual([
      {
        title: 'Review SDLC digest run-1 T-01',
        section: 'inbox',
        tags: ['follow-up']
      }
    ]);
  });

  it('appends into the Inbox of an existing queue without touching other sections', () => {
    mkdirSync(path.join(repo, 'chronicles'), { recursive: true });
    writeFileSync(
      queueFile(repo),
      [
        '# Work Queue',
        '',
        '## Active',
        '- [ ] Existing active item [jira:PROJ-1]',
        '',
        '## Inbox',
        '- [ ] Existing inbox item [idea]',
        ''
      ].join('\n')
    );

    const appended = queue.appendItem(repo, 'New digest item', ['follow-up']);

    expect(appended).toBe(true);
    const items = parseItems(readFileSync(queueFile(repo), 'utf-8'));
    expect(items).toHaveLength(3);
    expect(items.filter(i => i.section === 'active')).toHaveLength(1);
    const inbox = items.filter(i => i.section === 'inbox');
    expect(inbox.map(i => i.title)).toEqual([
      'New digest item',
      'Existing inbox item'
    ]);
  });

  it('is idempotent by title — re-appending the same item is a no-op', () => {
    expect(queue.appendItem(repo, 'Same title', ['follow-up'])).toBe(true);
    expect(queue.appendItem(repo, 'Same title', ['follow-up'])).toBe(false);

    const items = parseItems(readFileSync(queueFile(repo), 'utf-8'));
    expect(items.filter(i => i.title === 'Same title')).toHaveLength(1);
  });

  it('adds an Inbox section when the file has none', () => {
    mkdirSync(path.join(repo, 'chronicles'), { recursive: true });
    writeFileSync(queueFile(repo), '# Work Queue\n\n## Active\n');

    queue.appendItem(repo, 'Orphan item', []);

    const items = parseItems(readFileSync(queueFile(repo), 'utf-8'));
    expect(items).toEqual([
      { title: 'Orphan item', section: 'inbox', tags: [] }
    ]);
  });

  it('replaces the <!-- empty --> placeholder instead of stacking under it', () => {
    mkdirSync(path.join(repo, 'chronicles'), { recursive: true });
    writeFileSync(
      queueFile(repo),
      '# Work Queue\n\n## Inbox\n<!-- empty -->\n'
    );

    queue.appendItem(repo, 'First real item', []);

    const raw = readFileSync(queueFile(repo), 'utf-8');
    expect(raw).not.toContain('<!-- empty -->');
    expect(parseItems(raw)).toEqual([
      { title: 'First real item', section: 'inbox', tags: [] }
    ]);
  });
});
