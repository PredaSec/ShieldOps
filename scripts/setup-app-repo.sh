#!/usr/bin/env bash
# =============================================================================
# ShieldOps — create the DEVELOPER-facing application repository.
#
# Splits the demo into two perspectives:
#   • root/shieldops      — PLATFORM (DevSecOps): pipeline, policy, terraform,
#                           helm chart, ai-service, dashboard. (already exists)
#   • root/shieldops-app  — DEVELOPER: ONLY the app source + a thin .gitlab-ci.yml
#                           that `include:`s the central app pipeline.
#
# What this script does (idempotent):
#   1. create the root/shieldops-app project (if missing)
#   2. copy the platform project's CI/CD variables (API keys, KUBECONFIG, ...)
#   3. add the app project to the platform's CI job-token allowlist
#      (so the app pipeline can clone the platform repo at runtime)
#   4. push an app-only working tree (app/ minus the helm chart) + thin CI config
#
# Usage:  bash scripts/setup-app-repo.sh
# =============================================================================
set -uo pipefail
cd "$(dirname "$0")/.."

GITLAB_HOST="localhost:8929"
API="http://${GITLAB_HOST}/api/v4"
PLATFORM_PATH="root/shieldops"          # existing platform project
APP_PATH="root/shieldops-app"           # developer app project to create
APP_NAME="shieldops-app"
PLATFORM_REF="green-test"               # platform branch the app pipeline includes/clones
TOKEN_FILE="/tmp/ci_token.txt"

say()  { printf '\n\033[1;36m== %s\033[0m\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
die()  { printf '  \033[31m✗ %s\033[0m\n' "$*"; exit 1; }

[ -f "$TOKEN_FILE" ] || die "no token at $TOKEN_FILE — run scripts/startup.sh step 7 first"
TOKEN="$(cat "$TOKEN_FILE")"
hdr=(--header "PRIVATE-TOKEN: ${TOKEN}")

# ---------------------------------------------------------------------------
say "1/4  Create project ${APP_PATH} (if missing)"
PLATFORM_ID=$(curl -s "${hdr[@]}" "$API/projects/root%2Fshieldops" | python3 -c "import json,sys;print(json.load(sys.stdin).get('id',''))")
[ -n "$PLATFORM_ID" ] || die "could not resolve platform project id"
ok "platform project id=${PLATFORM_ID}"

APP_ID=$(curl -s "${hdr[@]}" "$API/projects/root%2Fshieldops-app" | python3 -c "import json,sys;print(json.load(sys.stdin).get('id',''))" 2>/dev/null)
if [ -z "$APP_ID" ]; then
  APP_ID=$(curl -s "${hdr[@]}" --request POST "$API/projects" \
            --data "name=${APP_NAME}&path=${APP_NAME}&visibility=internal&initialize_with_readme=false&default_branch=main" \
          | python3 -c "import json,sys;d=json.load(sys.stdin);print(d.get('id',''))")
  [ -n "$APP_ID" ] || die "failed to create ${APP_PATH}"
  ok "created ${APP_PATH} (id=${APP_ID})"
else
  warn "${APP_PATH} already exists (id=${APP_ID}) — will refresh it"
fi

# ---------------------------------------------------------------------------
say "2/4  Copy CI/CD variables platform → app (secrets not printed)"
PLATFORM_ID="$PLATFORM_ID" APP_ID="$APP_ID" API="$API" TOKEN="$TOKEN" python3 - <<'PY'
import json, os, urllib.request, urllib.parse, urllib.error
api, token = os.environ["API"], os.environ["TOKEN"]
app, platform = os.environ["APP_ID"], os.environ["PLATFORM_ID"]
def req(method, url, data=None):
    body = urllib.parse.urlencode(data).encode() if data else None
    r = urllib.request.Request(url, data=body, method=method,
                               headers={"PRIVATE-TOKEN": token})
    try:
        with urllib.request.urlopen(r) as resp: return resp.status, resp.read().decode()
    except urllib.error.HTTPError as e: return e.code, e.read().decode()
_, raw = req("GET", f"{api}/projects/{platform}/variables?per_page=100")
vs = json.loads(raw)
if isinstance(vs, dict):
    print("  ! could not read platform variables:", vs.get("message")); raise SystemExit(0)
for v in vs:
    payload = {"key": v["key"], "value": v["value"],
               "variable_type": v.get("variable_type", "env_var"),
               "masked": str(v.get("masked", False)).lower(),
               "protected": str(v.get("protected", False)).lower(),
               "raw": str(v.get("raw", False)).lower(),
               "environment_scope": v.get("environment_scope", "*")}
    code, _ = req("POST", f"{api}/projects/{app}/variables", payload)
    if code in (200, 201):
        print(f"  \033[32m✓\033[0m copied {v['key']}")
    elif code == 400:  # already exists -> update
        u = f"{api}/projects/{app}/variables/{urllib.parse.quote(v['key'], safe='')}"
        c2, _ = req("PUT", u, payload)
        print(f"  \033[32m✓\033[0m updated {v['key']}" if c2 == 200 else f"  ! {v['key']} update HTTP {c2}")
    else:
        print(f"  ! {v['key']} HTTP {code}")
PY

# ---------------------------------------------------------------------------
say "3/4  Allow the app project to clone the platform with its CI job token"
CODE=$(curl -s -o /dev/null -w '%{http_code}' "${hdr[@]}" --request POST \
        "$API/projects/${PLATFORM_ID}/job_token_scope/allowlist" \
        --data "target_project_id=${APP_ID}")
case "$CODE" in
  200|201) ok "added app project to platform's job-token allowlist" ;;
  400|422) ok "already in platform's job-token allowlist" ;;
  *)       warn "allowlist POST returned HTTP ${CODE} (configure manually: platform → Settings → CI/CD → Token Access)" ;;
esac

# Replicate the platform's dashboard webhook so the dev's runs show on the dashboard.
# The dashboard enforces GITLAB_WEBHOOK_TOKEN, so the hook MUST carry that token —
# otherwise every pipeline event is rejected (401) and app runs never appear.
HOOK_URL=$(curl -s "${hdr[@]}" "$API/projects/${PLATFORM_ID}/hooks" \
           | python3 -c "import json,sys;d=json.load(sys.stdin);print(d[0]['url'] if d else '')" 2>/dev/null)
WEBHOOK_TOKEN=$(grep -E '^GITLAB_WEBHOOK_TOKEN=' dashboard/.env 2>/dev/null | head -1 | cut -d= -f2- | tr -d '\r"')
if [ -n "$HOOK_URL" ]; then
  HID=$(curl -s "${hdr[@]}" "$API/projects/${APP_ID}/hooks" \
        | python3 -c "import json,sys;hs=json.load(sys.stdin);print(next((str(h['id']) for h in hs if h['url']=='${HOOK_URL}'),''))" 2>/dev/null)
  if [ -n "$HID" ]; then
    curl -s -o /dev/null "${hdr[@]}" --request PUT "$API/projects/${APP_ID}/hooks/$HID" \
      --data-urlencode "url=${HOOK_URL}" --data-urlencode "token=${WEBHOOK_TOKEN}" --data "pipeline_events=true" \
      && ok "dashboard webhook present (token synced)"
  else
    curl -s -o /dev/null "${hdr[@]}" --request POST "$API/projects/${APP_ID}/hooks" \
      --data-urlencode "url=${HOOK_URL}" --data-urlencode "token=${WEBHOOK_TOKEN}" \
      --data "pipeline_events=true&push_events=false&enable_ssl_verification=false" \
      && ok "added dashboard webhook → ${HOOK_URL}"
  fi
  [ -z "$WEBHOOK_TOKEN" ] && warn "GITLAB_WEBHOOK_TOKEN missing in dashboard/.env — hook has no token; dashboard will 401 it"
else
  warn "platform has no webhook to copy — dashboard may not list app runs"
fi

# ---------------------------------------------------------------------------
say "4/4  Push app-only working tree (app/ minus helm chart) + thin .gitlab-ci.yml"
EMPTY=$(curl -s "${hdr[@]}" "$API/projects/${APP_ID}" | python3 -c "import json,sys;print(json.load(sys.stdin).get('empty_repo'))")
if [ "$EMPTY" != "True" ]; then
  ok "app repo already populated — leaving its history intact (delete the project to re-import)"
  SKIP_PUSH=1
fi

if [ "${SKIP_PUSH:-0}" != "1" ]; then
WORK="$(mktemp -d)"
# Copy the application source; the Helm chart stays in the platform repo.
cp -a app/. "$WORK/"
rm -rf "$WORK/helm"

cat > "$WORK/.gitlab-ci.yml" <<YML
# =============================================================================
# ShieldOps demo — DEVELOPER's application repository.
#
# This repo contains ONLY the application. The 8-gate security pipeline is owned
# and maintained centrally by the DevSecOps / platform team in root/shieldops.
# We just pull in the app-stage pipeline; gate logic, policies, the Helm chart
# and the AI service all live in the platform project.
# =============================================================================
include:
  - project: '${PLATFORM_PATH}'
    ref: '${PLATFORM_REF}'
    file: '/ci/app-pipeline.yml'
YML

PUSH_URL="http://root:${TOKEN}@${GITLAB_HOST}/${APP_PATH}.git"
(
  cd "$WORK"
  git init -q -b main
  git config user.email "dev@keystone.tn"
  git config user.name  "App Developer"
  git add -A
  git commit -q -m "chore: import application source + central security pipeline include"
  git push "$PUSH_URL" main 2>&1 | grep -viE 'remote:|^To ' || true
)
rm -rf "$WORK"
# Source of truth: did the thin CI config land on main?
if curl -s -o /dev/null -w '%{http_code}' "${hdr[@]}" "$API/projects/${APP_ID}/repository/files/.gitlab-ci.yml?ref=main" | grep -q 200; then
  ok "pushed app source to ${APP_PATH} (branch main)"
else
  warn "push failed — check output above (is 'main' protected against this user?)"
fi
fi

# ---------------------------------------------------------------------------
say "Done — developer perspective"
printf '  Dev clones ONLY the app:\n'
printf '    TOKEN=$(cat %s)\n' "$TOKEN_FILE"
printf '    git clone "http://root:${TOKEN}@%s/%s.git"\n' "$GITLAB_HOST" "$APP_PATH"
printf '  App project:  http://%s/%s\n' "$GITLAB_HOST" "$APP_PATH"
printf '  Pipeline pulls: %s @ %s  (/ci/app-pipeline.yml)\n' "$PLATFORM_PATH" "$PLATFORM_REF"
echo
warn "The platform template must exist on ${PLATFORM_PATH}@${PLATFORM_REF}:"
warn "  ci/app-pipeline.yml  — publish it there before pushing app commits."
