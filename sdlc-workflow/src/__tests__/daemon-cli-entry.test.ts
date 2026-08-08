import { mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { WorkflowError } from '../types';
import { resolveDaemonCliEntry } from '../utils/daemon-cli-entry';

describe('resolveDaemonCliEntry', () => {
  it('returns a compiled .js entry unchanged', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'daemon-cli-js-'));
    const entry = path.join(root, 'dist', 'index.js');
    mkdirSync(path.dirname(entry), { recursive: true });
    writeFileSync(entry, 'module.exports = {};\n', 'utf-8');
    expect(resolveDaemonCliEntry(entry)).toBe(path.resolve(entry));
  });

  it('maps src/index.ts to dist/index.js when the build exists', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'daemon-cli-ts-'));
    const srcEntry = path.join(root, 'src', 'index.ts');
    const distEntry = path.join(root, 'dist', 'index.js');
    mkdirSync(path.dirname(srcEntry), { recursive: true });
    mkdirSync(path.dirname(distEntry), { recursive: true });
    writeFileSync(srcEntry, 'export {};\n', 'utf-8');
    writeFileSync(distEntry, 'module.exports = {};\n', 'utf-8');
    expect(resolveDaemonCliEntry(srcEntry)).toBe(path.resolve(distEntry));
  });

  it('fails loud when install is from TypeScript but dist is missing', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'daemon-cli-missing-'));
    const srcEntry = path.join(root, 'src', 'index.ts');
    mkdirSync(path.dirname(srcEntry), { recursive: true });
    writeFileSync(srcEntry, 'export {};\n', 'utf-8');
    expect(() => resolveDaemonCliEntry(srcEntry)).toThrow(WorkflowError);
    try {
      resolveDaemonCliEntry(srcEntry);
    } catch (err) {
      expect(err).toBeInstanceOf(WorkflowError);
      expect((err as WorkflowError).code).toBe('DAEMON_CLI_ENTRY_MISSING');
    }
  });

  it('allows a predicted dist path when requireDist is false (--no-load)', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'daemon-cli-noload-'));
    const srcEntry = path.join(root, 'src', 'index.ts');
    mkdirSync(path.dirname(srcEntry), { recursive: true });
    writeFileSync(srcEntry, 'export {};\n', 'utf-8');
    expect(resolveDaemonCliEntry(srcEntry, { requireDist: false })).toBe(
      path.join(root, 'dist', 'index.js')
    );
  });

  it('returns non-TypeScript entries unchanged', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'daemon-cli-bin-'));
    const entry = path.join(root, 'sdlc-workflow');
    writeFileSync(entry, '#!/usr/bin/env node\n', 'utf-8');
    expect(resolveDaemonCliEntry(entry)).toBe(path.resolve(entry));
  });
});
