import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import { layDownRootConfig } from '../services/config-files.service';

const TRACKED = path.resolve(
  __dirname,
  '..',
  '..',
  'templates',
  'root',
  '.cursor',
  'rules'
);

/**
 * `layDownRootConfig` regenerates `.cursor/rules` from `.claude/`, so the
 * tracked copies under templates/root/.cursor/rules are never installed —
 * but people read them. Keep them byte-identical to what the mirror writes.
 */
describe('tracked .cursor/rules templates', () => {
  let base: string;

  beforeAll(() => {
    base = mkdtempSync(path.join(os.tmpdir(), 'cursor-rules-'));
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    layDownRootConfig(base);
  });

  afterAll(() => {
    rmSync(base, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  it.each(readdirSync(TRACKED).filter(f => f.endsWith('.mdc')))(
    '%s matches the mirror of .claude/',
    file => {
      const generated = readFileSync(
        path.join(base, '.cursor', 'rules', file),
        'utf-8'
      );
      expect(readFileSync(path.join(TRACKED, file), 'utf-8')).toBe(generated);
    }
  );
});
