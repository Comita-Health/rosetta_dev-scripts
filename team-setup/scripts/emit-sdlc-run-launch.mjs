#!/usr/bin/env node
/**
 * Build the `sdlc-run-launch` repository_dispatch payload after a spec PR
 * merges. Workflow invokes the CLI; helpers are unit-tested via node:test.
 *
 *   --plan --merged-sha <sha> --pr-number <n> [--emitted-sha <sha>…]
 *     stdin paths → JSON plan ({ action: 'dispatch' | 'noop', … })
 *
 * Exactly-once: pass prior merge SHAs via --emitted-sha (workflow records a
 * commit-status context `sdlc-run-launch` after a successful POST).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Same shape as flip-spec-status.mjs — kept local so the workflow can extract this file alone. */
export const SPEC_PATH_RE = /^specs\/(?:.+\/)?phase-[^/]+-spec\.md$/;

export const EVENT_TYPE = 'sdlc-run-launch';

export function isSpecPath(filePath) {
  return SPEC_PATH_RE.test(filePath);
}

export function filterSpecPaths(paths) {
  return paths.filter(p => isSpecPath(p));
}

/**
 * @param {{ specPaths: string[], mergedSha: string, prNumber: number }} input
 * @returns {{ specPaths: string[], mergedSha: string, prNumber: number }}
 */
export function buildClientPayload(input) {
  return {
    specPaths: [...input.specPaths],
    mergedSha: input.mergedSha,
    prNumber: input.prNumber
  };
}

/**
 * @param {{
 *   paths: string[],
 *   mergedSha: string,
 *   prNumber: number | string,
 *   emittedShas?: string[]
 * }} input
 */
export function planEmit(input) {
  const specPaths = filterSpecPaths(input.paths);
  if (specPaths.length === 0) {
    return { action: 'noop', reason: 'no-spec-paths' };
  }

  const mergedSha =
    input.mergedSha === undefined || input.mergedSha === null
      ? ''
      : String(input.mergedSha).trim();
  if (mergedSha === '') {
    return { action: 'noop', reason: 'no-merged-sha' };
  }

  const emittedShas = input.emittedShas === undefined ? [] : input.emittedShas;
  if (emittedShas.includes(mergedSha) === true) {
    return { action: 'noop', reason: 'already-emitted' };
  }

  const prNumber =
    typeof input.prNumber === 'number'
      ? input.prNumber
      : Number(String(input.prNumber).trim());
  if (Number.isFinite(prNumber) === false) {
    return { action: 'noop', reason: 'invalid-pr-number' };
  }

  return {
    action: 'dispatch',
    event_type: EVENT_TYPE,
    client_payload: buildClientPayload({
      specPaths,
      mergedSha,
      prNumber
    })
  };
}

function readStdinPaths() {
  return readFileSync(0, 'utf8')
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l !== '');
}

function parseArgs(argv) {
  const mergedShaIdx = argv.indexOf('--merged-sha');
  const prIdx = argv.indexOf('--pr-number');
  const emittedShas = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--emitted-sha' && i + 1 < argv.length) {
      emittedShas.push(argv[i + 1]);
      i += 1;
    }
  }
  return {
    plan: argv.includes('--plan'),
    mergedSha: mergedShaIdx >= 0 ? (argv[mergedShaIdx + 1] ?? '') : '',
    prNumber: prIdx >= 0 ? (argv[prIdx + 1] ?? '') : '',
    emittedShas
  };
}

function main(argv) {
  const args = parseArgs(argv);
  if (args.plan === true) {
    const plan = planEmit({
      paths: readStdinPaths(),
      mergedSha: args.mergedSha,
      prNumber: args.prNumber,
      emittedShas: args.emittedShas
    });
    process.stdout.write(JSON.stringify(plan) + '\n');
    return;
  }
  process.stderr.write(
    'Usage: emit-sdlc-run-launch.mjs --plan --merged-sha <sha> --pr-number <n> [--emitted-sha <sha>…]\n'
  );
  process.exitCode = 2;
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main(process.argv.slice(2));
}
