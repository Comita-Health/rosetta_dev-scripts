#!/usr/bin/env bash
# Deploy addi-merge-webhook to AWS Lambda Function URL and wire org webhooks
# for pull_request_review.
#
# Tenants are config, not code. Defaults ship Rosetta-Foundation only:
#   ADDI_TENANTS=rosetta
#   ADDI_TENANT_ORGS=rosetta:Rosetta-Foundation
# Add another consumer by extending those lists and providing
#   ${TENANT}_CLIENT_ID and ${TENANT}_PEM (or ~/.config/${tenant}/github-app.pem).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

: "${AWS_PROFILE:?Set AWS_PROFILE to the account that hosts this Lambda}"
AWS_REGION="${AWS_REGION:-us-east-1}"
FUNCTION_NAME="${FUNCTION_NAME:-addi-merge-webhook}"
SECRET_NAME="${SECRET_NAME:-addi/merge-webhook}"
ROLE_NAME="${ROLE_NAME:-addi-merge-webhook-role}"
RUNTIME="${RUNTIME:-nodejs22.x}"
HANDLER="${HANDLER:-lambda.handler}"

ADDI_TENANTS="${ADDI_TENANTS:-rosetta}"
ADDI_TENANT_ORGS="${ADDI_TENANT_ORGS:-rosetta:Rosetta-Foundation}"

export AWS_PROFILE AWS_REGION

export ROSETTA_CLIENT_ID="${ROSETTA_CLIENT_ID:-Iv23lifPkkooMoMiz5Jk}"
export ROSETTA_PEM="${ROSETTA_PEM:-$HOME/.config/rosetta/github-app.pem}"

need() { command -v "$1" >/dev/null || { echo "missing $1" >&2; exit 1; }; }
need aws
need bun
need python3
need zip
need openssl

IFS=',' read -r -a TENANT_IDS <<<"$ADDI_TENANTS"
for tenant in "${TENANT_IDS[@]}"; do
  tenant="$(echo "$tenant" | tr '[:upper:]' '[:lower:]' | xargs)"
  [[ -n "$tenant" ]] || continue
  prefix="$(echo "$tenant" | tr '[:lower:]' '[:upper:]' | tr '-' '_')"
  client_var="${prefix}_CLIENT_ID"
  pem_var="${prefix}_PEM"
  if [[ -z "${!client_var:-}" ]]; then
    if [[ "$tenant" == "rosetta" ]]; then
      export ROSETTA_CLIENT_ID
    else
      echo "Set ${client_var} for tenant $tenant" >&2
      exit 1
    fi
  fi
  if [[ -z "${!pem_var:-}" ]]; then
    default_pem="$HOME/.config/$tenant/github-app.pem"
    if [[ -f "$default_pem" ]]; then
      export "${pem_var}=$default_pem"
    elif [[ "$tenant" == "rosetta" && -f "$ROSETTA_PEM" ]]; then
      export ROSETTA_PEM
    else
      echo "Set ${pem_var} (or place PEM at $default_pem) for tenant $tenant" >&2
      exit 1
    fi
  fi
  pem_path="${!pem_var:-}"
  [[ -f "$pem_path" ]] || { echo "missing $pem_path" >&2; exit 1; }
done

ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
echo "Deploying to account $ACCOUNT ($AWS_REGION) as $FUNCTION_NAME"
echo "Tenants: $ADDI_TENANTS"

# --- secret bundle -----------------------------------------------------------
EXISTING_SECRET="$(
  aws secretsmanager describe-secret --secret-id "$SECRET_NAME" \
    --query ARN --output text 2>/dev/null || true
)"

if [[ -n "$EXISTING_SECRET" && "$EXISTING_SECRET" != "None" ]]; then
  echo "Reusing webhook secrets from $SECRET_NAME"
  SECRET_JSON="$(aws secretsmanager get-secret-value --secret-id "$SECRET_NAME" \
    --query SecretString --output text)"
  SECRET_JSON="$(
    ADDI_TENANTS="$ADDI_TENANTS" SECRET_JSON="$SECRET_JSON" \
    env python3 - <<'PY'
import json, os, pathlib, secrets
tenants = [t.strip() for t in os.environ["ADDI_TENANTS"].split(",") if t.strip()]
old = json.loads(os.environ["SECRET_JSON"])
bundle = {"tenants": {}}
for tenant in tenants:
    prefix = tenant.upper().replace("-", "_")
    client = os.environ[f"{prefix}_CLIENT_ID"]
    pem = os.environ[f"{prefix}_PEM"]
    prev = old.get("tenants", {}).get(tenant, {})
    webhook = prev.get("webhookSecret") or secrets.token_hex(32)
    bundle["tenants"][tenant] = {
        "webhookSecret": webhook,
        "clientId": client,
        "privateKey": pathlib.Path(pem).read_text(),
    }
print(json.dumps(bundle))
PY
  )"
  aws secretsmanager put-secret-value --secret-id "$SECRET_NAME" \
    --secret-string "$SECRET_JSON" >/dev/null
else
  echo "Creating $SECRET_NAME"
  SECRET_JSON="$(
    ADDI_TENANTS="$ADDI_TENANTS" \
    env python3 - <<'PY'
import json, os, pathlib, secrets
tenants = [t.strip() for t in os.environ["ADDI_TENANTS"].split(",") if t.strip()]
bundle = {"tenants": {}}
for tenant in tenants:
    prefix = tenant.upper().replace("-", "_")
    bundle["tenants"][tenant] = {
        "webhookSecret": secrets.token_hex(32),
        "clientId": os.environ[f"{prefix}_CLIENT_ID"],
        "privateKey": pathlib.Path(os.environ[f"{prefix}_PEM"]).read_text(),
    }
print(json.dumps(bundle))
PY
  )"
  aws secretsmanager create-secret --name "$SECRET_NAME" \
    --secret-string "$SECRET_JSON" \
    --description "Addi merge-on-approve webhook bridge" >/dev/null
fi

SECRET_ARN="$(aws secretsmanager describe-secret --secret-id "$SECRET_NAME" \
  --query ARN --output text)"
echo "Secret ARN: $SECRET_ARN"

# --- IAM role ----------------------------------------------------------------
ROLE_ARN="$(aws iam get-role --role-name "$ROLE_NAME" --query Role.Arn --output text 2>/dev/null || true)"
if [[ -z "$ROLE_ARN" || "$ROLE_ARN" == "None" ]]; then
  echo "Creating IAM role $ROLE_NAME"
  TRUST='{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}'
  ROLE_ARN="$(aws iam create-role --role-name "$ROLE_NAME" \
    --assume-role-policy-document "$TRUST" --query Role.Arn --output text)"
  aws iam attach-role-policy --role-name "$ROLE_NAME" \
    --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
  POLICY_DOC="$(SECRET_ARN="$SECRET_ARN" python3 - <<'PY'
import json, os
print(json.dumps({
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": ["secretsmanager:GetSecretValue"],
    "Resource": os.environ["SECRET_ARN"],
  }],
}))
PY
)"
  aws iam put-role-policy --role-name "$ROLE_NAME" \
    --policy-name addi-merge-webhook-secrets \
    --policy-document "$POLICY_DOC"
  echo "Waiting for IAM role propagation..."
  sleep 12
else
  POLICY_DOC="$(SECRET_ARN="$SECRET_ARN" python3 - <<'PY'
import json, os
print(json.dumps({
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": ["secretsmanager:GetSecretValue"],
    "Resource": os.environ["SECRET_ARN"],
  }],
}))
PY
)"
  aws iam put-role-policy --role-name "$ROLE_NAME" \
    --policy-name addi-merge-webhook-secrets \
    --policy-document "$POLICY_DOC"
fi

# --- package -----------------------------------------------------------------
echo "Building package..."
bun install --frozen-lockfile
bun run build
rm -rf .deploy/pkg
mkdir -p .deploy/pkg
cp package.json bun.lock .deploy/pkg/
cp -R dist/. .deploy/pkg/
(
  cd .deploy/pkg
  bun install --production --frozen-lockfile
)

ZIP="$ROOT/.deploy/function.zip"
rm -f "$ZIP"
(
  cd .deploy/pkg
  zip -qr "$ZIP" .
)
echo "Zip size: $(du -h "$ZIP" | awk '{print $1}')"

# --- Lambda ------------------------------------------------------------------
EXISTING_FN="$(aws lambda get-function --function-name "$FUNCTION_NAME" \
  --query Configuration.FunctionArn --output text 2>/dev/null || true)"

ENV_JSON="$(SECRET_ARN="$SECRET_ARN" python3 - <<'PY'
import json, os
print(json.dumps({"Variables": {
  "ADDI_MERGE_WEBHOOK_SECRET_ARN": os.environ["SECRET_ARN"],
}}))
PY
)"

if [[ -z "$EXISTING_FN" || "$EXISTING_FN" == "None" ]]; then
  echo "Creating Lambda $FUNCTION_NAME"
  aws lambda create-function \
    --function-name "$FUNCTION_NAME" \
    --runtime "$RUNTIME" \
    --role "$ROLE_ARN" \
    --handler "$HANDLER" \
    --zip-file "fileb://$ZIP" \
    --timeout 30 \
    --memory-size 256 \
    --environment "$ENV_JSON" \
    --architectures x86_64 >/dev/null
else
  echo "Updating Lambda $FUNCTION_NAME"
  aws lambda update-function-code \
    --function-name "$FUNCTION_NAME" \
    --zip-file "fileb://$ZIP" >/dev/null
  aws lambda wait function-updated --function-name "$FUNCTION_NAME"
  aws lambda update-function-configuration \
    --function-name "$FUNCTION_NAME" \
    --runtime "$RUNTIME" \
    --handler "$HANDLER" \
    --timeout 30 \
    --memory-size 256 \
    --environment "$ENV_JSON" >/dev/null
  aws lambda wait function-updated --function-name "$FUNCTION_NAME"
fi

URL_CFG="$(aws lambda get-function-url-config --function-name "$FUNCTION_NAME" \
  --query FunctionUrl --output text 2>/dev/null || true)"
if [[ -z "$URL_CFG" || "$URL_CFG" == "None" ]]; then
  echo "Creating Function URL (AuthType NONE)"
  aws lambda create-function-url-config \
    --function-name "$FUNCTION_NAME" \
    --auth-type NONE >/dev/null
fi

aws lambda add-permission \
  --function-name "$FUNCTION_NAME" \
  --statement-id FunctionURLAllowPublicAccess \
  --action lambda:InvokeFunctionUrl \
  --principal '*' \
  --function-url-auth-type NONE >/dev/null 2>&1 || true
aws lambda add-permission \
  --function-name "$FUNCTION_NAME" \
  --statement-id FunctionURLAllowInvoke \
  --action lambda:InvokeFunction \
  --principal '*' >/dev/null 2>&1 || true

FUNCTION_URL="$(aws lambda get-function-url-config --function-name "$FUNCTION_NAME" \
  --query FunctionUrl --output text)"
FUNCTION_URL="${FUNCTION_URL%/}"
echo "Function URL: $FUNCTION_URL"

HEALTH="$(curl -fsS "$FUNCTION_URL/health" || true)"
echo "Health: $HEALTH"
[[ "$HEALTH" == '{"ok":true}' ]] || {
  echo "Health check failed" >&2
  exit 1
}

# --- org webhooks ------------------------------------------------------------
echo "Configuring org webhooks..."
ADDI_TENANT_ORGS="$ADDI_TENANT_ORGS" SECRET_JSON="$SECRET_JSON" \
FUNCTION_URL="$FUNCTION_URL" \
env python3 - <<'PY'
import json, os, time, base64, pathlib, urllib.request, urllib.error
from cryptography.hazmat.primitives import serialization, hashes
from cryptography.hazmat.primitives.asymmetric import padding

def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()

def jwt_for(pem_path: str, iss: str) -> str:
    key = serialization.load_pem_private_key(
        pathlib.Path(pem_path).read_bytes(), password=None
    )
    now = int(time.time())
    header = b64url(json.dumps({"alg": "RS256", "typ": "JWT"}).encode())
    payload = b64url(
        json.dumps({"iat": now - 60, "exp": now + 540, "iss": str(iss)}).encode()
    )
    signing = f"{header}.{payload}".encode()
    sig = key.sign(signing, padding.PKCS1v15(), hashes.SHA256())
    return f"{header}.{payload}.{b64url(sig)}"

def api(method, url, token, body=None):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(
        url,
        data=data,
        method=method,
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "addi-merge-webhook-deploy",
            "Content-Type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req) as r:
            raw = r.read().decode()
            return r.status, json.loads(raw) if raw else None
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()

def installation_token(pem, client_id, org):
    jwt = jwt_for(pem, client_id)
    st, installs = api("GET", "https://api.github.com/app/installations", jwt)
    if st != 200:
        raise SystemExit(f"list installations failed: {st} {installs}")
    inst = next(i for i in installs if i["account"]["login"] == org)
    st, tok = api(
        "POST",
        f"https://api.github.com/app/installations/{inst['id']}/access_tokens",
        jwt,
    )
    if st != 201:
        raise SystemExit(f"token failed: {st} {tok}")
    return tok["token"]

def upsert_org_hook(org, token, url, secret):
    st, hooks = api("GET", f"https://api.github.com/orgs/{org}/hooks", token)
    if st != 200:
        raise SystemExit(f"list hooks {org}: {st} {hooks}")
    suffix = "/" + "/".join(url.rstrip("/").split("/")[-2:])
    existing = None
    for h in hooks:
        cfg_url = ((h.get("config") or {}).get("url") or "").rstrip("/")
        if cfg_url == url.rstrip("/") or cfg_url.endswith(suffix):
            existing = h
            break
    body = {
        "name": "web",
        "active": True,
        "events": ["pull_request_review"],
        "config": {
            "url": url,
            "content_type": "json",
            "insecure_ssl": "0",
            "secret": secret,
        },
    }
    if existing is None:
        st, created = api(
            "POST", f"https://api.github.com/orgs/{org}/hooks", token, body
        )
        if st not in (200, 201):
            raise SystemExit(f"create hook {org}: {st} {created}")
        print(f"{org}: created hook id={created['id']} url={url}")
        return created["id"]
    hid = existing["id"]
    st, updated = api(
        "PATCH", f"https://api.github.com/orgs/{org}/hooks/{hid}", token, body
    )
    if st != 200:
        raise SystemExit(f"update hook {org}: {st} {updated}")
    print(f"{org}: updated hook id={hid} url={url}")
    return hid

bundle = json.loads(os.environ["SECRET_JSON"])
base = os.environ["FUNCTION_URL"].rstrip("/")
pairs = [p.strip() for p in os.environ["ADDI_TENANT_ORGS"].split(",") if p.strip()]
for pair in pairs:
    tenant, org = pair.split(":", 1)
    tenant, org = tenant.strip(), org.strip()
    prefix = tenant.upper().replace("-", "_")
    pem = os.environ[f"{prefix}_PEM"]
    client_id = os.environ[f"{prefix}_CLIENT_ID"]
    secret = bundle["tenants"][tenant]["webhookSecret"]
    upsert_org_hook(
        org,
        installation_token(pem, client_id, org),
        f"{base}/webhook/{tenant}",
        secret,
    )
print("Org webhooks configured.")
PY

mkdir -p "$HOME/.config/rosetta"
echo "$FUNCTION_URL" >"$HOME/.config/rosetta/addi-merge-webhook.url"
echo "Wrote $HOME/.config/rosetta/addi-merge-webhook.url"
echo
echo "Deploy complete."
echo "  Health: $FUNCTION_URL/health"
for tenant in "${TENANT_IDS[@]}"; do
  tenant="$(echo "$tenant" | xargs)"
  [[ -n "$tenant" ]] || continue
  echo "  $tenant:  $FUNCTION_URL/webhook/$tenant"
done
