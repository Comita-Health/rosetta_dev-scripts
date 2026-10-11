import { execFileSync } from 'child_process';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'fs';
import { tmpdir } from 'os';
import path from 'path';

const SCRIPT = path.resolve(
  __dirname,
  '../../templates/root/.cursor/skills/deploy-verify-watch/scripts/watch-deploy-verify.sh'
);

/**
 * A fake `gh` for one PR. Poll 1 reports head `aaa`, poll 2 a new head
 * `bbb`, poll 3 merged. `run list` returns `RUNS_JSON`. Every
 * `workflow run` is appended to `$FAKE_LOG`.
 */
const FAKE_GH = `#!/usr/bin/env bash
set -euo pipefail
args="$*"
case "$args" in
  "workflow run"*)
    echo "DISPATCH $args" >>"$FAKE_LOG"
    ;;
  "run list"*)
    cat "$FAKE_DIR/runs.json"
    ;;
  "api "*)
    exit 1
    ;;
  *"--json state,headRefName,headRefOid --jq"*)
    echo '{"state":"OPEN","branch":"f/x","sha":"aaa"}'
    ;;
  *"--json state,headRefName,headRefOid"*)
    n=$(( $(cat "$FAKE_DIR/polls" 2>/dev/null || echo 0) + 1 ))
    echo "$n" >"$FAKE_DIR/polls"
    case "$n" in
      1) echo '{"state":"OPEN","headRefName":"f/x","headRefOid":"aaa"}' ;;
      2) echo '{"state":"OPEN","headRefName":"f/x","headRefOid":"bbb"}' ;;
      *) echo '{"state":"MERGED","headRefName":"f/x","headRefOid":"bbb"}' ;;
    esac
    ;;
  *"--json files"*)
    echo '{"files":[{"path":"packages/app/backend/src/a.ts"}]}'
    ;;
  "pr view"*)
    echo '{"title":"","body":"","labels":[],"files":[],"headRefName":"f/x"}'
    ;;
  *)
    echo '{}'
    ;;
esac
`;

function run(runs: unknown[]): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'deploy-verify-'));
  try {
    const bin = path.join(dir, 'bin');
    execFileSync('mkdir', ['-p', bin]);
    writeFileSync(path.join(bin, 'gh'), FAKE_GH);
    chmodSync(path.join(bin, 'gh'), 0o755);
    writeFileSync(path.join(dir, 'runs.json'), JSON.stringify(runs));
    writeFileSync(path.join(dir, 'activate.sh'), '');
    writeFileSync(path.join(dir, 'log'), '');
    execFileSync(
      'bash',
      [
        SCRIPT,
        '--interval',
        '0',
        '--activate',
        path.join(dir, 'activate.sh'),
        'Owner/repo#1'
      ],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH ?? ''}`,
          FAKE_DIR: dir,
          FAKE_LOG: path.join(dir, 'log'),
          WATCHER_LOCK_ROOT: path.join(dir, 'locks')
        }
      }
    );
    return readFileSync(path.join(dir, 'log'), 'utf8');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const green = {
  databaseId: 1,
  headSha: 'aaa',
  status: 'completed',
  conclusion: 'success',
  event: 'workflow_dispatch',
  url: 'u1'
};

describe('watch-deploy-verify', () => {
  it('adopts a run already queued for a new head instead of replacing it', () => {
    const queued = {
      databaseId: 2,
      headSha: 'bbb',
      status: 'queued',
      conclusion: '',
      event: 'workflow_dispatch',
      url: 'u2'
    };
    expect(run([queued, green])).toBe('');
  });

  it('dispatches a new head with the backend when the PR changes it', () => {
    const log = run([green]);
    expect(log.trim().split('\n')).toHaveLength(1);
    expect(log).toContain('backend=true');
  });
});
