#!/usr/bin/env bash
# Idempotent install for the Cursor Cloud "Comita" multi-repo environment.
# Secrets are injected by Cursor as env vars (environment-scoped). This script
# materializes ~/.config/comita so existing Addi activate scripts work, then
# installs toolchain + package deps.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

log() { printf '[comita-cloud-install] %s\n' "$*"; }

ensure_cmd() {
  local cmd="$1"
  if command -v "$cmd" >/dev/null 2>&1; then
    return 0
  fi
  return 1
}

install_toolchain() {
  if ! ensure_cmd curl; then
    log 'curl missing — cannot bootstrap toolchain'
    exit 1
  fi

  if ! ensure_cmd node; then
    log 'installing Node 20 via nvm-less node binary is environment-dependent; relying on base image'
  fi

  if ! ensure_cmd bun; then
    log 'installing bun'
    curl -fsSL https://bun.sh/install | bash
    # shellcheck disable=SC1090
    export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
    export PATH="$BUN_INSTALL/bin:$PATH"
  fi

  if ! ensure_cmd gh; then
    log 'installing GitHub CLI'
    if ensure_cmd apt-get; then
      (curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
        | sudo dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg) || true
      sudo chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg || true
      echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
        | sudo tee /etc/apt/sources.list.d/github-cli.list >/dev/null || true
      sudo apt-get update -y && sudo apt-get install -y gh || log 'gh apt install failed — agent may install later'
    else
      log 'apt-get unavailable — skip gh package install'
    fi
  fi

  export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
  export PATH="$BUN_INSTALL/bin:$PATH"
}

# Normalize a PEM (or PEM-like) secret from Cursor/dashboard env injection:
# strip wrapping quotes, turn literal \n into real newlines, and re-chunk
# space-collapsed single-line PEMs (Cursor secrets UI often replaces
# newlines with spaces, which breaks OpenSSL / cryptography load).
normalize_pem_secret() {
  python3 - <<'PY'
import os, sys

def rewrap_pem(text: str) -> str:
    markers = (
        ("-----BEGIN RSA PRIVATE KEY-----", "-----END RSA PRIVATE KEY-----"),
        ("-----BEGIN PRIVATE KEY-----", "-----END PRIVATE KEY-----"),
    )
    for begin, end in markers:
        if begin not in text or end not in text:
            continue
        body = text.split(begin, 1)[1].split(end, 1)[0]
        body = "".join(body.split())
        if len(body) < 64:
            continue
        lines = [body[i : i + 64] for i in range(0, len(body), 64)]
        return begin + "\n" + "\n".join(lines) + "\n" + end + "\n"
    return text if text.endswith("\n") else text + "\n"

raw = os.environ.get("GITHUB_APP_PRIVATE_KEY", "")
text = raw.strip()
if (len(text) >= 2) and ((text[0] == text[-1] == '"') or (text[0] == text[-1] == "'")):
    text = text[1:-1]
text = text.replace("\\r\\n", "\n").replace("\\n", "\n").replace("\r\n", "\n")
text = text.strip()
# Cursor dashboard paste often yields one line with spaces instead of
# newlines (same char length as a real PEM). Always rewrap when we can.
sys.stdout.write(rewrap_pem(text))
PY
}

pem_looks_complete() {
  local pem_path="$1"
  python3 - "$pem_path" <<'PY'
import sys
from pathlib import Path

pem = Path(sys.argv[1]).read_text()
has_begin = ("BEGIN" in pem) and ("PRIVATE KEY" in pem)
end_idx = pem.find("END")
has_end = (end_idx >= 0) and ("PRIVATE KEY" in pem[end_idx:])
if not (has_begin and has_end and len(pem) >= 200):
    sys.exit(1)
try:
    from cryptography.hazmat.primitives.serialization import load_pem_private_key
except ImportError:
    sys.exit(0)
try:
    load_pem_private_key(pem.encode(), password=None)
except Exception:
    sys.exit(1)
sys.exit(0)
PY
}

materialize_addi() {
  if [[ -z "${GITHUB_APP_ID:-}" || -z "${GITHUB_APP_INSTALLATION_ID:-}" ]]; then
    log 'Addi secrets not present yet — skipping ~/.config/comita materialize'
    log 'Note: environment Builds often lack secrets; runtime agent injects them and re-runs install / materialize.'
    return 0
  fi
  if [[ -z "${GITHUB_APP_PRIVATE_KEY:-}" ]]; then
    log 'GITHUB_APP_PRIVATE_KEY missing — skipping Addi materialize'
    return 0
  fi

  local cfg="$HOME/.config/comita"
  mkdir -p "$cfg"
  chmod 700 "$cfg"

  umask 077
  normalize_pem_secret >"$cfg/github-app.pem"
  chmod 600 "$cfg/github-app.pem"
  if ! pem_looks_complete "$cfg/github-app.pem"; then
    local pem_bytes
    pem_bytes="$(wc -c <"$cfg/github-app.pem" | tr -d ' ')"
    log "ERROR: GITHUB_APP_PRIVATE_KEY is not a complete PEM (bytes=${pem_bytes}; need BEGIN+END PRIVATE KEY, typically >200 bytes)."
    log 'Fix: set the Comita env secret to the full addi-m App private key (BEGIN…END). Real newlines, literal \\n, or space-collapsed single-line pastes are OK after normalize/rewrap.'
    return 1
  fi

  cat >"$cfg/github-app.env" <<EOF
GITHUB_APP_ID='${GITHUB_APP_ID}'
GITHUB_APP_CLIENT_ID='${GITHUB_APP_CLIENT_ID:-}'
GITHUB_APP_INSTALLATION_ID='${GITHUB_APP_INSTALLATION_ID}'
GITHUB_APP_SLUG='${GITHUB_APP_SLUG:-addi-m}'
GITHUB_APP_PRIVATE_KEY_PATH='$cfg/github-app.pem'

GIT_AUTHOR_NAME='${GIT_AUTHOR_NAME:-Addi M.}'
GIT_AUTHOR_EMAIL='${GIT_AUTHOR_EMAIL:-russ+adjutant@bakerstreet.engineering}'
GIT_COMMITTER_NAME='${GIT_COMMITTER_NAME:-${GIT_AUTHOR_NAME:-Addi M.}}'
GIT_COMMITTER_EMAIL='${GIT_COMMITTER_EMAIL:-${GIT_AUTHOR_EMAIL:-russ+adjutant@bakerstreet.engineering}}'
EOF
  chmod 600 "$cfg/github-app.env"

  # Same token mint path as laptop ~/.config/comita/github-app-token.sh
  if ! python3 -c 'import cryptography' >/dev/null 2>&1; then
    log 'pip install cryptography (Addi JWT mint)'
    python3 -m pip install --user -q cryptography || pip3 install --user -q cryptography || true
  fi
  cat >"$cfg/github-app-token.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
set -a
# shellcheck disable=SC1090
source "$HOME/.config/comita/github-app.env"
set +a
python3 - <<'PY'
import base64, json, os, time, urllib.request
from pathlib import Path
from cryptography.hazmat.primitives import serialization, hashes
from cryptography.hazmat.primitives.asymmetric import padding

app_id = os.environ["GITHUB_APP_ID"].strip("'\"")
install_id = os.environ["GITHUB_APP_INSTALLATION_ID"].strip("'\"")
pem_path = os.environ["GITHUB_APP_PRIVATE_KEY_PATH"].strip("'\"")
pem = Path(pem_path).read_text().strip()
if (len(pem) >= 2) and ((pem[0] == pem[-1] == '"') or (pem[0] == pem[-1] == "'")):
    pem = pem[1:-1]
pem = pem.replace("\\r\\n", "\n").replace("\\n", "\n").replace("\r\n", "\n").strip() + "\n"

def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()

header = b64url(json.dumps({"alg": "RS256", "typ": "JWT"}).encode())
now = int(time.time())
payload = b64url(json.dumps({"iat": now - 60, "exp": now + 540, "iss": app_id}).encode())
signing_input = f"{header}.{payload}".encode()
key = serialization.load_pem_private_key(pem.encode(), password=None)
sig = key.sign(signing_input, padding.PKCS1v15(), hashes.SHA256())
jwt_token = f"{header}.{payload}.{b64url(sig)}"

req = urllib.request.Request(
    f"https://api.github.com/app/installations/{install_id}/access_tokens",
    method="POST",
    headers={
        "Authorization": f"Bearer {jwt_token}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "comita-addi-cloud",
    },
    data=b"",
)
with urllib.request.urlopen(req) as resp:
    body = json.load(resp)
print(body["token"])
PY
EOF
  chmod 700 "$cfg/github-app-token.sh"

  cat >"$cfg/github-app-activate.sh" <<'EOF'
#!/usr/bin/env bash
# Usage: eval "$(bash ~/.config/comita/github-app-activate.sh)"
set -euo pipefail
ENV_FILE="$HOME/.config/comita/github-app.env"
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a
TOKEN=$(bash "$HOME/.config/comita/github-app-token.sh")
strip_q() { local v="$1"; v="${v#\'}"; v="${v%\'}"; printf '%s' "$v"; }
NAME=$(strip_q "${GIT_AUTHOR_NAME}")
EMAIL=$(strip_q "${GIT_AUTHOR_EMAIL}")
printf "export GH_TOKEN=%q\n" "$TOKEN"
printf "export GITHUB_TOKEN=%q\n" "$TOKEN"
printf "export GIT_AUTHOR_NAME=%q\n" "$NAME"
printf "export GIT_AUTHOR_EMAIL=%q\n" "$EMAIL"
printf "export GIT_COMMITTER_NAME=%q\n" "$(strip_q "${GIT_COMMITTER_NAME}")"
printf "export GIT_COMMITTER_EMAIL=%q\n" "$(strip_q "${GIT_COMMITTER_EMAIL}")"
printf "export GITHUB_APP_ID=%q\n" "$(strip_q "${GITHUB_APP_ID}")"
printf "export GITHUB_APP_INSTALLATION_ID=%q\n" "$(strip_q "${GITHUB_APP_INSTALLATION_ID}")"
printf "export GITHUB_APP_SLUG=%q\n" "$(strip_q "${GITHUB_APP_SLUG:-addi-m}")"
EOF
  chmod 700 "$cfg/github-app-activate.sh"

  log "materialized Addi config under $cfg"
  # Smoke: mint a token (fails loud if secrets wrong)
  if bash "$cfg/github-app-token.sh" >/dev/null; then
    log 'Addi installation token mint OK'
  else
    log 'WARN: Addi token mint failed — check environment secrets'
  fi
}

install_deps() {
  export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
  export PATH="$BUN_INSTALL/bin:$PATH"
  if [[ -f "$ROOT/package.json" ]]; then
    log 'bun install (repo root)'
    bun install
  fi
  if [[ -f "$ROOT/sdlc-workflow/package.json" ]]; then
    log 'bun install (sdlc-workflow)'
    (cd "$ROOT/sdlc-workflow" && bun install && bun run build)
  fi
  if [[ -f "$ROOT/team-setup/package.json" ]]; then
    log 'bun install (team-setup)'
    (cd "$ROOT/team-setup" && bun install && bun run build)
  fi
}

install_toolchain
materialize_addi
install_deps
log 'done'
