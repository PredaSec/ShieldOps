#!/usr/bin/env bash
# =============================================================================
# Re-run the DEVELOPER app pipeline (root/shieldops-app).
#
#   bash scripts/run-app-pipeline.sh            # fresh pipeline on main
#   bash scripts/run-app-pipeline.sh <branch>   # fresh pipeline on <branch>
#   bash scripts/run-app-pipeline.sh --retry    # retry latest pipeline's failed jobs
#   bash scripts/run-app-pipeline.sh --watch     # fresh pipeline + live status
#
# A "fresh pipeline" re-runs every gate from scratch (use after a skip/cancel or a
# template change). "--retry" keeps green jobs and only re-runs failed/canceled ones.
# =============================================================================
set -uo pipefail
GITLAB=http://localhost:8929
API="$GITLAB/api/v4"
APP_PATH=root%2Fshieldops-app          # url-encoded root/shieldops-app
TOKEN="$(cat /tmp/ci_token.txt 2>/dev/null)"
[ -n "$TOKEN" ] || { echo "no token at /tmp/ci_token.txt (run scripts/startup.sh)"; exit 1; }
hdr=(--header "PRIVATE-TOKEN: $TOKEN")

APP_ID=$(curl -s "${hdr[@]}" "$API/projects/$APP_PATH" | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")

REF=main; MODE=new; WATCH=0
for a in "$@"; do
  case "$a" in
    --retry) MODE=retry ;;
    --watch) WATCH=1 ;;
    --*)     echo "unknown flag: $a"; exit 1 ;;
    *)       REF="$a" ;;
  esac
done

if [ "$MODE" = retry ]; then
  PID=$(curl -s "${hdr[@]}" "$API/projects/$APP_ID/pipelines?per_page=1" | python3 -c "import json,sys;print(json.load(sys.stdin)[0]['id'])")
  curl -s --request POST "${hdr[@]}" "$API/projects/$APP_ID/pipelines/$PID/retry" >/dev/null
  echo "retried pipeline $PID  ->  $GITLAB/root/shieldops-app/-/pipelines/$PID"
else
  read -r PID URL < <(curl -s --request POST "${hdr[@]}" "$API/projects/$APP_ID/pipeline?ref=$REF" \
    | python3 -c "import json,sys;d=json.load(sys.stdin);print(d.get('id',''),d.get('web_url',d.get('message','')))")
  [ -n "$PID" ] || { echo "failed to start pipeline (ref '$REF' valid?)"; exit 1; }
  echo "started pipeline $PID on '$REF'  ->  $URL"
fi

if [ "$WATCH" = 1 ]; then
  echo "watching (Ctrl-C to stop)..."
  while :; do
    OUT=$(curl -s "${hdr[@]}" "$API/projects/$APP_ID/pipelines/$PID/jobs?per_page=100" \
      | python3 -c "import json,sys;d=sorted(json.load(sys.stdin),key=lambda x:x['id']);print(' | '.join(j['name']+':'+j['status'] for j in d))")
    S=$(curl -s "${hdr[@]}" "$API/projects/$APP_ID/pipelines/$PID" | python3 -c "import json,sys;print(json.load(sys.stdin)['status'])")
    printf '\r  [%s] %s\033[K' "$S" "$OUT"
    case "$S" in success|failed|canceled|manual|blocked) echo; echo "  final: $S"; break;; esac
    sleep 10
  done
fi
