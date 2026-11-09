#!/usr/bin/env bash
# =============================================================================
# ci/upload-report.sh
#
# Upload a gate report file to LocalStack S3.
# Called from every gate job's after_script.
#
# Usage:
#   upload-report.sh <gate-name> <file1> [file2 ...]
#
# Environment variables expected (set as GitLab CI variables or job env):
#   CI_PIPELINE_ID       — GitLab pipeline ID (e.g. 42)
#   AWS_ENDPOINT_URL     — LocalStack endpoint (default: http://localstack:4566)
#   S3_REPORTS_BUCKET    — S3 bucket name    (default: shieldops-reports)
#
# Example:
#   upload-report.sh g1-secrets gitleaks.json
#   upload-report.sh g2-sast semgrep.sarif semgrep.json
# =============================================================================

set -euo pipefail

GATE="${1:?Usage: upload-report.sh <gate> <file> [file...]}"
shift
FILES=("$@")

ENDPOINT="${AWS_ENDPOINT_URL:-http://localstack:4566}"
BUCKET="${S3_REPORTS_BUCKET:-shieldops-reports}"
PIPELINE_ID="${CI_PIPELINE_ID:-unknown}"

S3_PREFIX="s3://${BUCKET}/${PIPELINE_ID}/${GATE}"

echo "[upload-report] Gate: ${GATE}  Pipeline: ${PIPELINE_ID}  Endpoint: ${ENDPOINT}"

# Ensure the bucket exists (idempotent; LocalStack may be fresh after restart)
aws --endpoint-url "${ENDPOINT}" \
    s3 mb "s3://${BUCKET}" 2>/dev/null || true

for FILE in "${FILES[@]}"; do
  if [[ -f "${FILE}" ]]; then
    DEST="${S3_PREFIX}/$(basename "${FILE}")"
    echo "[upload-report] Uploading ${FILE} → ${DEST}"
    aws --endpoint-url "${ENDPOINT}" \
        s3 cp "${FILE}" "${DEST}" \
        --no-progress
  else
    echo "[upload-report] WARNING: file not found: ${FILE}" >&2
  fi
done

echo "[upload-report] Done."
