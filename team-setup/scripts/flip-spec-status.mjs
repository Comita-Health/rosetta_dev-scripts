#!/usr/bin/env node
/**
 * Flip `status: Draft → Approved` in ADR-0008 phase-spec front-matter.
 * Workflow invokes the CLI; helpers are unit-tested via node:test.
 *
 *   --filter-paths   stdin paths → specs/.../phase-*-spec.md
 *   --write-stdin    flip matching paths on disk; print JSON plan
 *   --write <files>  same for argv files
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const SPEC_PATH_RE = /^specs\/(?:.+\/)?phase-[^/]+-spec\.md$/;

export function isSpecPath(filePath) {
  return SPEC_PATH_RE.test(filePath);
}

export function filterSpecPaths(paths) {
  return paths.filter(p => isSpecPath(p));
}

/** Rewrite only front-matter status value; comment + other lines unchanged. */
export function flipDraftStatus(content) {
  const bodyStart = content.startsWith('---\n')
    ? 4
    : content.startsWith('---\r\n')
      ? 5
      : -1;
  if (bodyStart < 0) return { content, changed: false };
  const closeAt = content.indexOf('\n---', bodyStart);
  if (closeAt < 0) return { content, changed: false };
  const fm = content.slice(bodyStart, closeAt);
  const re = /^(status:[ \t]*)Draft([ \t]*(?:#.*)?)$/m;
  if (re.test(fm) === false) return { content, changed: false };
  return {
    content:
      content.slice(0, bodyStart) +
      fm.replace(re, '$1Approved$2') +
      content.slice(closeAt),
    changed: true
  };
}

export function extractSpecId(content) {
  const m = content.match(/^id:[ \t]*(.+)$/m);
  return m === null ? null : m[1].trim();
}

export function buildCommitMessage(flips) {
  const ids = flips.map(f => f.id).filter(id => id !== null && id !== '');
  return `docs(spec): approve ${ids.length > 0 ? ids.join(', ') : 'spec'} on human Approve`;
}

export function planFlip(paths, readFile) {
  const specs = filterSpecPaths(paths);
  if (specs.length === 0) return { action: 'noop', reason: 'no-spec-paths' };
  const flips = [];
  for (const p of specs) {
    const { content, changed } = flipDraftStatus(readFile(p));
    if (changed === true)
      flips.push({ path: p, content, id: extractSpecId(content) });
  }
  if (flips.length === 0) return { action: 'noop', reason: 'already-approved' };
  return { action: 'commit', flips, message: buildCommitMessage(flips) };
}

export function writeFlips(paths) {
  const plan = planFlip(paths, p => readFileSync(p, 'utf8'));
  if (plan.action === 'noop') return { action: 'noop', reason: plan.reason };
  for (const flip of plan.flips) writeFileSync(flip.path, flip.content, 'utf8');
  return {
    action: 'commit',
    flipped: plan.flips.map(f => f.path),
    message: plan.message
  };
}

function readStdinPaths() {
  return readFileSync(0, 'utf8')
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l !== '');
}

function main(argv) {
  if (argv.includes('--filter-paths')) {
    const specs = filterSpecPaths(readStdinPaths());
    process.stdout.write(specs.join('\n') + (specs.length > 0 ? '\n' : ''));
    return;
  }
  if (argv.includes('--write-stdin')) {
    process.stdout.write(JSON.stringify(writeFlips(readStdinPaths())) + '\n');
    return;
  }
  const i = argv.indexOf('--write');
  if (i >= 0) {
    process.stdout.write(
      JSON.stringify(writeFlips(argv.slice(i + 1).filter(a => a !== '--'))) +
        '\n'
    );
    return;
  }
  process.stderr.write(
    'Usage: flip-spec-status.mjs --filter-paths | --write-stdin | --write <files…>\n'
  );
  process.exitCode = 2;
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main(process.argv.slice(2));
}
