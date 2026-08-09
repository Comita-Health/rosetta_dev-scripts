#!/usr/bin/env bash
# Mint a short-lived GitHub App installation token for __WORKSPACE__.
# Requires: python3 + cryptography, and github-app.env + github-app.pem.

set -euo pipefail

CONFIG_DIR="$HOME/.config/__WORKSPACE__"
ENV_FILE="$CONFIG_DIR/github-app.env"

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

python3 - <<'PY'
import base64, json, os, time, urllib.request
from pathlib import Path
from cryptography.hazmat.primitives import serialization, hashes
from cryptography.hazmat.primitives.asymmetric import padding

app_id = os.environ["GITHUB_APP_ID"].strip("'\"")
install_id = os.environ["GITHUB_APP_INSTALLATION_ID"].strip("'\"")
pem_path = os.environ["GITHUB_APP_PRIVATE_KEY_PATH"].strip("'\"")
pem_path = os.path.expanduser(pem_path)
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

slug = os.environ.get("GITHUB_APP_SLUG", "github-app").strip("'\"") or "github-app"
req = urllib.request.Request(
    f"https://api.github.com/app/installations/{install_id}/access_tokens",
    method="POST",
    headers={
        "Authorization": f"Bearer {jwt_token}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": f"{slug}-local-agent",
    },
    data=b"",
)
with urllib.request.urlopen(req) as resp:
    body = json.load(resp)
print(body["token"])
PY
