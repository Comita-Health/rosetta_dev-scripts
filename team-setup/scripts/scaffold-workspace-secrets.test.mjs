import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const scaffold = path.join(__dirname, 'scaffold-workspace-secrets.sh');
const verify = path.join(__dirname, 'verify-workspace-secrets.sh');

function run(script, args, env = {}) {
  const result = spawnSync('bash', [script, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env }
  });
  return result;
}

test('scaffold creates scripts with workspace substitution', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ws-secrets-'));
  const configHome = path.join(root, '.config');
  const hooksDir = path.join(root, '.cursor', 'hooks');
  try {
    const result = run(scaffold, [
      '--workspace',
      'acme',
      '--config-home',
      configHome,
      '--cursor-hooks-dir',
      hooksDir,
      '--print-next-steps'
    ]);
    assert.equal(result.status, 0, result.stderr || result.stdout);

    const activate = path.join(configHome, 'acme', 'github-app-activate.sh');
    assert.ok(existsSync(activate));
    const body = readFileSync(activate, 'utf8');
    assert.match(body, /\/\.config\/acme\//);
    assert.doesNotMatch(body, /__WORKSPACE__/);

    const hook = path.join(hooksDir, 'acme-slack-session-start.sh');
    assert.ok(existsSync(hook));
    assert.doesNotMatch(readFileSync(hook, 'utf8'), /__WORKSPACE__/);

    const slackExample = path.join(configHome, 'acme', 'slack.env.example');
    assert.ok(existsSync(slackExample));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('scaffold does not overwrite existing slack.env', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ws-secrets-'));
  const configHome = path.join(root, '.config');
  const hooksDir = path.join(root, '.cursor', 'hooks');
  const target = path.join(configHome, 'acme');
  try {
    spawnSync('bash', [
      scaffold,
      '--workspace',
      'acme',
      '--config-home',
      configHome,
      '--cursor-hooks-dir',
      hooksDir
    ]);
    const secretPath = path.join(target, 'slack.env');
    writeFileSync(secretPath, 'SLACK_BOT_TOKEN=xoxb-test\n', { mode: 0o600 });
    chmodSync(secretPath, 0o600);

    const second = run(scaffold, [
      '--workspace',
      'acme',
      '--config-home',
      configHome,
      '--cursor-hooks-dir',
      hooksDir,
      '--force'
    ]);
    assert.equal(second.status, 0, second.stderr || second.stdout);
    assert.equal(readFileSync(secretPath, 'utf8'), 'SLACK_BOT_TOKEN=xoxb-test\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('verify reports missing secrets as warnings (non-strict)', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ws-secrets-'));
  const configHome = path.join(root, '.config');
  const hooksDir = path.join(root, '.cursor', 'hooks');
  try {
    run(scaffold, [
      '--workspace',
      'acme',
      '--config-home',
      configHome,
      '--cursor-hooks-dir',
      hooksDir
    ]);
    const result = run(verify, [
      '--workspace',
      'acme',
      '--config-home',
      configHome
    ]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /Result: OK/);
    assert.match(result.stdout, /slack\.env missing/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('verify --strict fails when slack.env missing', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ws-secrets-'));
  const configHome = path.join(root, '.config');
  const hooksDir = path.join(root, '.cursor', 'hooks');
  try {
    run(scaffold, [
      '--workspace',
      'acme',
      '--config-home',
      configHome,
      '--cursor-hooks-dir',
      hooksDir
    ]);
    const result = run(verify, [
      '--workspace',
      'acme',
      '--config-home',
      configHome,
      '--strict'
    ]);
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /Result: FAIL/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('--register-cursor-hook appends sessionStart once', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ws-secrets-'));
  const configHome = path.join(root, '.config');
  const hooksDir = path.join(root, '.cursor', 'hooks');
  const hooksJson = path.join(root, '.cursor', 'hooks.json');
  try {
    mkdirSync(path.dirname(hooksJson), { recursive: true });
    writeFileSync(
      hooksJson,
      JSON.stringify(
        {
          version: 1,
          hooks: {
            sessionStart: [{ command: '/existing/chronicle.sh' }]
          }
        },
        null,
        2
      )
    );
    const args = [
      '--workspace',
      'acme',
      '--config-home',
      configHome,
      '--cursor-hooks-dir',
      hooksDir,
      '--hooks-json',
      hooksJson,
      '--register-cursor-hook'
    ];
    assert.equal(run(scaffold, args).status, 0);
    assert.equal(run(scaffold, args).status, 0);
    const doc = JSON.parse(readFileSync(hooksJson, 'utf8'));
    const commands = doc.hooks.sessionStart.map(e => e.command);
    assert.equal(commands.filter(c => c.includes('acme-slack-session-start')).length, 1);
    assert.ok(commands.includes('/existing/chronicle.sh'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
