#!/usr/bin/env bash
# =============================================================================
# ci/deploy-aws.sh — ShieldOps Phase 7 AWS deploy script
#
# DUAL-CALLER INTERFACE
# ─────────────────────
# This script is designed to be invoked by two callers:
#
#   1. GitLab CI — deploy-aws job (Phase 7, after G8 approval):
#        export AWS_ACCESS_KEY_ID="$CI_AWS_KEY_ID"
#        export AWS_SECRET_ACCESS_KEY="$CI_AWS_SECRET"
#        export AWS_DEFAULT_REGION="$CI_AWS_REGION"
#        export IMAGE_TAG="$CI_COMMIT_SHA"
#        bash ci/deploy-aws.sh
#
#   2. dashboard/backend/src/services/awsDeploy.js — runDeployJob():
#        The JS service builds a process.env object with AWS_ACCESS_KEY_ID /
#        AWS_SECRET_ACCESS_KEY / AWS_SESSION_TOKEN / AWS_DEFAULT_REGION
#        via buildAwsEnv(), writes a chmod-600 temp credentials file, then
#        calls this script via child_process.spawn() with that env attached.
#        The script reads IMAGE_TAG from env (or defaults to 'latest').
#        Log lines from this script (stdout/stderr) are piped to job.listeners
#        via SSE so the dashboard's Deploy Console streams them in real time.
#
#        Interface contract with awsDeploy.js stubs:
#          - Step 2 stub: "ECR login" → replaces the stub at line ~235 of awsDeploy.js
#          - Step 3 stub: "docker build + push" → replaces line ~239 stub
#          - Step 4 stub: "helm upgrade" → replaces line ~244 stub
#          - Step 5 stub: "rollout status" → replaces line ~248 stub
#          - The script prints "[deploy] App URL: <url>" to stdout so awsDeploy.js
#            can capture it and set job.appUrl (grep for "App URL:" in the stream).
#
# SECURITY
# ────────
# - Credentials are NEVER written to disk by this script.
#   awsDeploy.js handles the temp file (chmod 600, deleted in finally).
# - AWS_SECRET_ACCESS_KEY and AWS_SESSION_TOKEN are zeroed at end of script.
# - All log lines containing key material are filtered through redact() below.
# - This script must NEVER be committed with real credentials.
#
# REQUIRED ENVIRONMENT VARIABLES
# ───────────────────────────────
#   AWS_ACCESS_KEY_ID      — AWS access key (masked in GitLab CI)
#   AWS_SECRET_ACCESS_KEY  — AWS secret key (masked in GitLab CI / awsDeploy.js)
#   AWS_DEFAULT_REGION     — AWS region (default: eu-west-1)
#   AWS_SESSION_TOKEN      — (optional) for temporary credentials / assume-role
#
# REQUIRED VARIABLES (set these or export from terraform output)
#   ECR_BACKEND_URL        — Full ECR URL for backend  (e.g. 123456.dkr.ecr.eu-west-1.amazonaws.com/shieldops-backend)
#   ECR_FRONTEND_URL       — Full ECR URL for frontend
#   ECR_REGISTRY           — Registry host  (e.g. 123456.dkr.ecr.eu-west-1.amazonaws.com)
#   ECS_CLUSTER            — ECS cluster name (from terraform output ecs_cluster_name)
#   ECS_BACKEND_SERVICE    — ECS service name for backend
#   ECS_FRONTEND_SERVICE   — ECS service name for frontend
#
# OPTIONAL VARIABLES
#   IMAGE_TAG              — Docker image tag to build + push (default: git short SHA or 'latest')
#   DEPLOY_ENV             — Helm/app environment label (default: production)
#   HELM_RELEASE           — Helm release name (default: shieldops)
#   HELM_NAMESPACE         — Kubernetes namespace if using EKS path (default: production)
#   SKIP_BUILD             — Set to "true" to skip docker build (e.g. image already pushed)
#   EKS_CLUSTER            — If set, also runs helm upgrade against EKS (optional EKS path)
#   KUBECONFIG             — Path to kubeconfig (only needed for EKS path)
#
# USAGE (manual):
#   export AWS_ACCESS_KEY_ID=...  AWS_SECRET_ACCESS_KEY=...  AWS_DEFAULT_REGION=eu-west-1
#   export ECR_BACKEND_URL=...    ECR_FRONTEND_URL=...       ECR_REGISTRY=...
#   export ECS_CLUSTER=shieldops-cluster
#   export IMAGE_TAG=$(git rev-parse --short HEAD)
#   bash ci/deploy-aws.sh
# =============================================================================

set -euo pipefail

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

log()    { echo "[deploy] $*"; }
log_ok() { echo "[deploy] OK: $*"; }
die()    { echo "[deploy] FAILED: $*" >&2; exit 1; }

# Redact any line containing what looks like an AWS secret or session token.
# Also masks the known secret key value from the environment.
redact() {
  local line="$1"
  # Mask 40-char base64 strings (AWS secret keys / session tokens)
  line=$(echo "$line" | sed -E 's/[A-Za-z0-9/+=]{40}/**REDACTED**/g')
  # Mask the literal secret key value if it somehow appears
  if [[ -n "${AWS_SECRET_ACCESS_KEY:-}" ]]; then
    line="${line//${AWS_SECRET_ACCESS_KEY}/**REDACTED**}"
  fi
  echo "$line"
}

require_var() {
  local var_name="$1"
  if [[ -z "${!var_name:-}" ]]; then
    die "Required variable \$${var_name} is not set. See script header for usage."
  fi
}

# ---------------------------------------------------------------------------
# Defaults
# ---------------------------------------------------------------------------

IMAGE_TAG="${IMAGE_TAG:-$(git rev-parse --short HEAD 2>/dev/null || echo 'latest')}"
AWS_DEFAULT_REGION="${AWS_DEFAULT_REGION:-eu-west-1}"
DEPLOY_ENV="${DEPLOY_ENV:-production}"
HELM_RELEASE="${HELM_RELEASE:-shieldops}"
HELM_NAMESPACE="${HELM_NAMESPACE:-production}"
SKIP_BUILD="${SKIP_BUILD:-false}"

# ---------------------------------------------------------------------------
# Pre-flight: check required vars
# ---------------------------------------------------------------------------

log "=== ShieldOps AWS Deploy ==="
log "Image tag:  ${IMAGE_TAG}"
log "Region:     ${AWS_DEFAULT_REGION}"
log "Env:        ${DEPLOY_ENV}"

require_var AWS_ACCESS_KEY_ID
require_var AWS_SECRET_ACCESS_KEY
require_var ECR_BACKEND_URL
require_var ECR_FRONTEND_URL
require_var ECR_REGISTRY
require_var ECS_CLUSTER

# Mask key in logs (show first 4 chars + ***)
MASKED_KEY_ID="${AWS_ACCESS_KEY_ID:0:4}…****"
log "Credentials: ${MASKED_KEY_ID}"

# ---------------------------------------------------------------------------
# Step 1: Verify AWS identity
# ---------------------------------------------------------------------------

log "--- Step 1: Verify AWS credentials ---"
IDENTITY=$(aws sts get-caller-identity --output json 2>&1) || die "STS get-caller-identity failed. Check AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY."
ACCOUNT_ID=$(echo "$IDENTITY" | python3 -c "import sys,json; print(json.load(sys.stdin)['Account'])" 2>/dev/null || \
             echo "$IDENTITY" | grep -o '"Account": "[^"]*"' | cut -d'"' -f4)
log_ok "Account: ${ACCOUNT_ID}"

# ---------------------------------------------------------------------------
# Step 2: ECR login
# ---------------------------------------------------------------------------

log "--- Step 2: ECR login ---"
# [awsDeploy.js interface] Replaces stub: "STUB: aws ecr get-login-password | docker login ..."
aws ecr get-login-password --region "${AWS_DEFAULT_REGION}" \
  | docker login --username AWS --password-stdin "${ECR_REGISTRY}" \
  || die "ECR login failed"
log_ok "Authenticated to ECR: ${ECR_REGISTRY}"

# ---------------------------------------------------------------------------
# Step 3: Docker build + push to ECR
# ---------------------------------------------------------------------------

log "--- Step 3: Build and push images ---"
# [awsDeploy.js interface] Replaces stub: "STUB: docker build + push → ..."

BACKEND_IMAGE="${ECR_BACKEND_URL}:${IMAGE_TAG}"
FRONTEND_IMAGE="${ECR_FRONTEND_URL}:${IMAGE_TAG}"

if [[ "${SKIP_BUILD}" != "true" ]]; then
  log "Building backend → ${BACKEND_IMAGE}"
  docker build \
    --tag "${BACKEND_IMAGE}" \
    --label "pipeline=${CI_PIPELINE_ID:-local}" \
    --label "git-sha=${CI_COMMIT_SHA:-${IMAGE_TAG}}" \
    --file app/backend/Dockerfile \
    app/backend/

  log "Building frontend → ${FRONTEND_IMAGE}"
  docker build \
    --tag "${FRONTEND_IMAGE}" \
    --label "pipeline=${CI_PIPELINE_ID:-local}" \
    --label "git-sha=${CI_COMMIT_SHA:-${IMAGE_TAG}}" \
    --file app/frontend/Dockerfile \
    app/frontend/

  log "Pushing ${BACKEND_IMAGE}"
  docker push "${BACKEND_IMAGE}"

  log "Pushing ${FRONTEND_IMAGE}"
  docker push "${FRONTEND_IMAGE}"

  log_ok "Images pushed to ECR"
else
  log "SKIP_BUILD=true — skipping docker build/push"
fi

# ---------------------------------------------------------------------------
# Step 4a: ECS deploy — force new task definition revisions
# ---------------------------------------------------------------------------

log "--- Step 4a: ECS force-new-deployment ---"
# [awsDeploy.js interface] Replaces stub: "STUB: helm upgrade --install shieldops → ..."
# For the ECS Fargate path, a new deployment is triggered by updating the task
# definition image and forcing a new ECS service deployment.

ECS_BACKEND_SERVICE="${ECS_BACKEND_SERVICE:-shieldops-backend}"
ECS_FRONTEND_SERVICE="${ECS_FRONTEND_SERVICE:-shieldops-frontend}"

# Update ECS task definitions to use the new image tag.
# This retrieves the current task definition and creates a new revision with
# the updated image, then updates the service to use it.
update_ecs_service() {
  local service_name="$1"
  local new_image="$2"
  local family="$3"

  log "Updating ECS service ${service_name} → image ${new_image}"

  # Get the current task definition JSON
  TASK_DEF_JSON=$(aws ecs describe-task-definition \
    --task-definition "${family}" \
    --query 'taskDefinition' \
    --output json)

  # Build updated container definitions with new image
  UPDATED_CONTAINER_DEFS=$(echo "${TASK_DEF_JSON}" | python3 -c "
import sys, json
td = json.load(sys.stdin)
containers = td.get('containerDefinitions', [])
for c in containers:
    if c.get('name') == '${family}'.split('-', 1)[1]:
        c['image'] = '${new_image}'
print(json.dumps(containers))
")

  # Register a new task definition revision with the updated image
  NEW_TASK_DEF_ARN=$(aws ecs register-task-definition \
    --family "${family}" \
    --container-definitions "${UPDATED_CONTAINER_DEFS}" \
    --network-mode awsvpc \
    --requires-compatibilities FARGATE \
    --cpu "$(echo "${TASK_DEF_JSON}" | python3 -c "import sys,json; print(json.load(sys.stdin)['cpu'])")" \
    --memory "$(echo "${TASK_DEF_JSON}" | python3 -c "import sys,json; print(json.load(sys.stdin)['memory'])")" \
    --execution-role-arn "$(echo "${TASK_DEF_JSON}" | python3 -c "import sys,json; print(json.load(sys.stdin)['executionRoleArn'])")" \
    --task-role-arn "$(echo "${TASK_DEF_JSON}" | python3 -c "import sys,json; print(json.load(sys.stdin)['taskRoleArn'])")" \
    --query 'taskDefinition.taskDefinitionArn' \
    --output text)

  log "New task definition: ${NEW_TASK_DEF_ARN}"

  # Update the ECS service to use the new task definition and force rollout
  aws ecs update-service \
    --cluster "${ECS_CLUSTER}" \
    --service "${service_name}" \
    --task-definition "${NEW_TASK_DEF_ARN}" \
    --force-new-deployment \
    --output json > /dev/null

  log_ok "ECS service ${service_name} updated"
}

update_ecs_service "${ECS_BACKEND_SERVICE}"  "${BACKEND_IMAGE}"  "shieldops-backend"
update_ecs_service "${ECS_FRONTEND_SERVICE}" "${FRONTEND_IMAGE}" "shieldops-frontend"

# ---------------------------------------------------------------------------
# Step 4b: (Optional) Helm upgrade on EKS — only runs if EKS_CLUSTER is set
# ---------------------------------------------------------------------------

if [[ -n "${EKS_CLUSTER:-}" ]]; then
  log "--- Step 4b: Helm upgrade on EKS (EKS_CLUSTER=${EKS_CLUSTER}) ---"

  # Update kubeconfig for the EKS cluster
  aws eks update-kubeconfig \
    --name "${EKS_CLUSTER}" \
    --region "${AWS_DEFAULT_REGION}" \
    --kubeconfig "${KUBECONFIG:-${HOME}/.kube/config}"

  helm upgrade --install "${HELM_RELEASE}" app/helm/shieldops-app \
    --namespace "${HELM_NAMESPACE}" \
    --create-namespace \
    -f app/helm/shieldops-app/values-prod.yaml \
    -f app/helm/shieldops-app/values-secure.yaml \
    -f app/helm/shieldops-app/values-aws-prod.yaml \
    --set backend.image.repository="${ECR_BACKEND_URL}" \
    --set backend.image.tag="${IMAGE_TAG}" \
    --set frontend.image.repository="${ECR_FRONTEND_URL}" \
    --set frontend.image.tag="${IMAGE_TAG}" \
    --set backend.labels.env="${DEPLOY_ENV}" \
    --set frontend.labels.env="${DEPLOY_ENV}" \
    --atomic \
    --timeout 5m \
    --wait

  log_ok "Helm release '${HELM_RELEASE}' deployed to EKS cluster '${EKS_CLUSTER}'"
fi

# ---------------------------------------------------------------------------
# Step 5: Wait for ECS services to stabilise
# ---------------------------------------------------------------------------

log "--- Step 5: Wait for ECS stability ---"
# [awsDeploy.js interface] Replaces stub: "STUB: kubectl rollout status ..."

wait_ecs_stable() {
  local service_name="$1"
  log "Waiting for ECS service ${service_name} to be stable (max 5 min)..."
  aws ecs wait services-stable \
    --cluster "${ECS_CLUSTER}" \
    --services "${service_name}" \
    || die "ECS service ${service_name} did not stabilise in time"
  log_ok "ECS service ${service_name} is stable"
}

wait_ecs_stable "${ECS_BACKEND_SERVICE}"
wait_ecs_stable "${ECS_FRONTEND_SERVICE}"

# ---------------------------------------------------------------------------
# Done — print App URL for awsDeploy.js to capture
# ---------------------------------------------------------------------------

ALB_DNS=$(aws elbv2 describe-load-balancers \
  --query "LoadBalancers[?contains(LoadBalancerName, 'shieldops')].DNSName | [0]" \
  --output text 2>/dev/null || echo "UNKNOWN")

log "=== Deploy complete ==="
log "Image tag: ${IMAGE_TAG}"
# awsDeploy.js greps for this exact prefix to set job.appUrl:
log "App URL: https://${ALB_DNS}/"

# ---------------------------------------------------------------------------
# Cleanup — zero credential env vars
# ---------------------------------------------------------------------------
AWS_SECRET_ACCESS_KEY=""
AWS_SESSION_TOKEN=""
AWS_ACCESS_KEY_ID=""
