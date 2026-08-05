import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'fs';
import os from 'os';
import path from 'path';
import { writeFileAtomic } from '../utils/atomic-write';

const scratchFiles = (dir: string): string[] =>
  readdirSync(dir).filter(entry => entry.includes('.tmp.'));

describe('writeFileAtomic (SPEC-PRD-0021-P1 T-01)', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'sdlc-atomic-'));
    file = path.join(dir, 'state.json');
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('writes the file and leaves no scratch file behind', () => {
    writeFileAtomic(file, '{"a":1}\n');

    expect(readFileSync(file, 'utf-8')).toBe('{"a":1}\n');
    expect(readdirSync(dir)).toEqual(['state.json']);
  });

  // The signature failure of an in-place write is a shorter second write
  // leaving a tail of the first, which for JSON yields trailing garbage after
  // a valid document — parseable by some readers, wrong for all of them.
  it('replaces a longer file completely rather than writing in place', () => {
    writeFileAtomic(file, `${JSON.stringify({ pad: 'a'.repeat(500) })}\n`);
    writeFileAtomic(file, '{"b":2}\n');

    expect(readFileSync(file, 'utf-8')).toBe('{"b":2}\n');
  });

  it('leaves the previous file intact and parseable when a write fails', () => {
    writeFileAtomic(file, '{"good":true}\n');
    // A regular file standing where a directory must be is a reproducible
    // stand-in for failing partway through the write.
    const notADir = path.join(dir, 'not-a-dir');
    writeFileSync(notADir, 'x');

    expect(() =>
      writeFileAtomic(path.join(notADir, 'state.json'), '{"bad":true}')
    ).toThrow();

    expect(JSON.parse(readFileSync(file, 'utf-8'))).toEqual({ good: true });
  });

  it('cleans up the scratch file when the rename fails', () => {
    // Renaming a file over an existing directory fails *after* the scratch
    // file exists — the one window where a leak would be observable.
    mkdirSync(path.join(dir, 'occupied'));

    expect(() =>
      writeFileAtomic(path.join(dir, 'occupied'), 'contents')
    ).toThrow();

    expect(scratchFiles(dir)).toEqual([]);
  });

  it('writes content larger than one write buffer without truncating', () => {
    const big = `${JSON.stringify({ blob: 'x'.repeat(2_000_000) })}\n`;

    writeFileAtomic(file, big);

    expect(readFileSync(file, 'utf-8')).toBe(big);
  });

  it('writes multibyte content without splitting a character', () => {
    // Byte-length and character-length differ here, so a length-based loop
    // that mixed the two would corrupt the last character.
    const contents = `${JSON.stringify({ reason: '健康 — ✅ deployed' })}\n`;

    writeFileAtomic(file, contents);

    expect(JSON.parse(readFileSync(file, 'utf-8'))).toEqual({
      reason: '健康 — ✅ deployed'
    });
  });

  it('keeps concurrent writers from splicing into one another', async () => {
    // Distinct scratch names per writer: last rename wins, but no reader can
    // ever see a mix of the two payloads.
    const payloads = Array.from(
      { length: 12 },
      (_unused, index) => `${JSON.stringify({ writer: index })}\n`
    );

    await Promise.all(
      payloads.map(async contents => writeFileAtomic(file, contents))
    );

    expect(payloads).toContain(readFileSync(file, 'utf-8'));
    expect(scratchFiles(dir)).toEqual([]);
  });
});
