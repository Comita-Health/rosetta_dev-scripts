import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import path from 'path';

const TEMPLATES = path.resolve(__dirname, '../../templates/root');
const CURSOR_HELPER = path.join(
  TEMPLATES,
  '.cursor/skills/_lib/watcher-singleton.sh'
);
const CLAUDE_HELPER = path.join(
  TEMPLATES,
  '.claude/skills/_lib/watcher-singleton.sh'
);

const sha256 = (filePath: string): string =>
  createHash('sha256').update(readFileSync(filePath)).digest('hex');

describe('watcher-singleton', () => {
  it('keeps .cursor and .claude helper copies content-identical', () => {
    expect(existsSync(CURSOR_HELPER)).toBe(true);
    expect(existsSync(CLAUDE_HELPER)).toBe(true);
    expect(sha256(CURSOR_HELPER)).toBe(sha256(CLAUDE_HELPER));
  });

  it('skips a live duplicate and reclaims a stale pid', () => {
    const script = `
set -euo pipefail
source ${JSON.stringify(CURSOR_HELPER)}
ROOT=$(mktemp -d)
export WATCHER_LOCK_ROOT="$ROOT"
trap 'rm -rf "$ROOT"' EXIT

claim_watch_targets testdup 'Owner/repo#1'
test "\${#CLAIMED_TARGETS[@]}" -eq 1

claim_watch_targets testdup 'Owner/repo#1'
test "\${#CLAIMED_TARGETS[@]}" -eq 0
test "\${#SKIPPED_TARGETS[@]}" -eq 1

STALE=$(watch_lock_dir_for testdup 'Owner/repo#2')
mkdir -p "$STALE"
printf '9999999\\n' >"$STALE/pid"
claim_watch_targets testdup 'Owner/repo#2'
test "\${#CLAIMED_TARGETS[@]}" -eq 1

bash -c "source ${JSON.stringify(CURSOR_HELPER)}; WATCHER_LOCK_ROOT=$ROOT; claim_watch_targets testdup 'Owner/repo#3'; sleep 20" &
HOLDER=$!
sleep 0.3
claim_watch_targets testdup 'Owner/repo#3'
test "\${#SKIPPED_TARGETS[@]}" -eq 1
kill "$HOLDER" 2>/dev/null || true
wait "$HOLDER" 2>/dev/null || true
release_watch_locks
`;
    execFileSync('bash', ['-c', script], { encoding: 'utf8' });
  });

  it('wires session-mortal watchers to the helper', () => {
    const scripts = [
      '.cursor/skills/deploy-verify-watch/scripts/watch-deploy-verify.sh',
      '.claude/skills/deploy-verify-watch/scripts/watch-deploy-verify.sh',
      '.cursor/skills/issue-resolve-watch/scripts/watch-issue-resolve.sh',
      '.claude/skills/issue-resolve-watch/scripts/watch-issue-resolve.sh'
    ];
    for (const rel of scripts) {
      const source = readFileSync(path.join(TEMPLATES, rel), 'utf8');
      expect(source).toMatch(/watcher-singleton\.sh/);
      expect(source).toMatch(/already armed/);
      expect(source).toMatch(/claim_watch_targets/);
    }
  });
});
