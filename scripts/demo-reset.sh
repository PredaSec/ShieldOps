#!/usr/bin/env bash
# =============================================================================
# ShieldOps Demo Reset Script
#
# Resets the environment to a clean pre-demo state.
# Safe to run repeatedly. Comments explain exactly what each step does.
#
# WHAT THIS DOES:
#   1. Restarts the Docker Compose services (GitLab, LocalStack, Registry, Postgres, Dashboard)
#   2. Re-provisions LocalStack S3 buckets + Secrets Manager (Terraform apply)
#   3. Verifies the kind cluster is running
#   4. Verifies the app namespaces exist
#   5. Redeploys the app to the development namespace from the last built image
#   6. Verifies the observability stack (monitoring namespace) is running
#   7. Prints the final status and all access URLs
#
# WHAT THIS DOES NOT DO (safe by design):
#   - Does NOT delete GitLab projects, users, or pipeline history
#   - Does NOT delete the kind cluster or any Kubernetes namespaces
#   - Does NOT delete the container registry images
#   - Does NOT wipe the dashboard database (pipeline history is preserved)
#   - Does NOT delete S3 report data (LocalStack community does not persist anyway)
#   - Does NOT modify any source files or git branches
#
# USAGE:
#   bash scripts/demo-reset.sh
#
# PREREQUISITES:
#   - Passwordless sudo configured (sudo -n docker ...)
#   - kind binary installed
#   - helm v3 installed
#   - KUBECONFIG accessible via kind get kubeconfig
# =============================================================================

set -euo pipefail

INFRA_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
KUBECONFIG_FILE="/tmp/kc-demoresetd"

echo "============================================================"
echo " ShieldOps Demo Reset"
echo "============================================================"

# ---------------------------------------------------------------------------
# 1. Get the kind kubeconfig
# ---------------------------------------------------------------------------
echo "[1/7] Fetching kind kubeconfig..."
sudo -n kind get kubeconfig --name shieldops-cluster > "$KUBECONFIG_FILE" 2>/dev/null || {
  echo "ERROR: Could not get kubeconfig. Is the kind cluster running?"
  echo "  Run: sudo -n kind create cluster --name shieldops-cluster --config kubernetes/kind-config.yaml"
  exit 1
}
export KUBECONFIG="$KUBECONFIG_FILE"
echo "  kind cluster: OK"

# ---------------------------------------------------------------------------
# 2. Restart Docker Compose services (non-destructive: up -d is idempotent)
# ---------------------------------------------------------------------------
echo "[2/7] Restarting Docker Compose services..."
cd "$INFRA_DIR"
sudo -n docker compose up -d --remove-orphans 2>&1 | grep -E "Running|Starting|Created|Error" || true

# Wait for GitLab health (up to 60 seconds)
echo "  Waiting for GitLab to become healthy..."
for i in $(seq 1 12); do
  STATUS=$(curl -s --max-time 5 "http://gitlab.local:8929/-/readiness" 2>/dev/null \
    | python3 -c "import sys,json; print(json.load(sys.stdin).get('status','err'))" 2>/dev/null || echo "err")
  if [ "$STATUS" = "ok" ]; then
    echo "  GitLab: OK"
    break
  fi
  echo "  GitLab not ready yet (attempt $i/12), waiting 5s..."
  sleep 5
done

# ---------------------------------------------------------------------------
# 3. Re-provision LocalStack (S3 buckets + Secrets Manager)
# LocalStack community does not persist data. After a container restart,
# all S3 buckets are gone. Re-run terraform apply to recreate them.
# ---------------------------------------------------------------------------
echo "[3/7] Re-provisioning LocalStack via Terraform..."
cd "$INFRA_DIR/terraform"

# Wait for LocalStack to be ready
for i in $(seq 1 12); do
  LSHEALTH=$(curl -s --max-time 5 "http://localhost:4566/_localstack/health" 2>/dev/null \
    | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('services',{}).get('s3','err'))" 2>/dev/null || echo "err")
  if [ "$LSHEALTH" = "running" ]; then
    echo "  LocalStack: ready"
    break
  fi
  echo "  LocalStack not ready (attempt $i/12), waiting 5s..."
  sleep 5
done

terraform init -input=false -no-color > /dev/null 2>&1 || true
terraform apply -auto-approve -input=false -no-color 2>&1 | tail -5 || {
  echo "  WARNING: Terraform apply failed. S3 bucket may not exist."
  echo "  Pipeline report uploads will be non-fatal (they use '|| true')."
}

cd "$INFRA_DIR"

# ---------------------------------------------------------------------------
# 4. Verify kind cluster namespaces
# ---------------------------------------------------------------------------
echo "[4/7] Verifying Kubernetes namespaces..."
for NS in development staging production monitoring; do
  kubectl get namespace "$NS" --no-headers 2>/dev/null | awk '{print "  namespace/"$1": "$2}' || {
    echo "  Creating namespace: $NS"
    kubectl create namespace "$NS" || true
  }
done

# ---------------------------------------------------------------------------
# 5. Redeploy app to development namespace
# Uses the 'latest' tag that was built by the last CI/CD pipeline or
# ci/build-and-push.sh run. Does not rebuild images.
# ---------------------------------------------------------------------------
echo "[5/7] Redeploying app to 'development' namespace..."
helm upgrade --install shieldops \
  "$INFRA_DIR/app/helm/shieldops-app" \
  --namespace development \
  -f "$INFRA_DIR/app/helm/shieldops-app/values-dev.yaml" \
  --set frontend.service.nodePort=30000 \
  --set backend.image.tag=latest \
  --set frontend.image.tag=latest \
  --wait \
  --timeout 3m \
  2>&1 | tail -5 || echo "  WARNING: Helm deploy to development failed. Check: kubectl get pods -n development"

# ---------------------------------------------------------------------------
# 6. Restart dashboard (non-destructive: docker compose up -d is idempotent)
# ---------------------------------------------------------------------------
echo "[6/7] Ensuring dashboard is running..."
cd "$INFRA_DIR/dashboard"
sudo -n docker compose up -d 2>&1 | grep -E "Running|Starting|Created|Error" || true

# Wait for dashboard health
for i in $(seq 1 6); do
  DHEALTHZ=$(curl -s --max-time 5 "http://localhost:4000/healthz" 2>/dev/null \
    | python3 -c "import sys,json; print(json.load(sys.stdin).get('status','err'))" 2>/dev/null || echo "err")
  if [ "$DHEALTHZ" = "ok" ]; then
    echo "  Dashboard backend: OK"
    break
  fi
  echo "  Dashboard not ready (attempt $i/6), waiting 5s..."
  sleep 5
done

cd "$INFRA_DIR"

# ---------------------------------------------------------------------------
# 7. Verify observability stack
# ---------------------------------------------------------------------------
echo "[7/7] Verifying observability stack..."
MONITORING_PODS=$(kubectl get pods -n monitoring --no-headers 2>/dev/null | grep -c Running || echo 0)
echo "  Pods running in 'monitoring' namespace: $MONITORING_PODS"
if [ "$MONITORING_PODS" -lt 5 ]; then
  echo "  WARNING: Expected 8 pods running. Run: cd observability && ./install.sh"
fi

# ---------------------------------------------------------------------------
# Final status report
# ---------------------------------------------------------------------------
echo ""
echo "============================================================"
echo " Demo Reset Complete — Access URLs"
echo "============================================================"
echo ""
echo "  App (development):  http://localhost:30000"
echo "  GitLab:             http://gitlab.local:8929"
echo "  GitLab pipelines:   http://gitlab.local:8929/root/shieldops/-/pipelines"
echo "  Dashboard:          http://localhost:8088"
echo "  Grafana:            http://172.18.0.2:32000  (admin / shieldops-grafana)"
echo "  Prometheus:         http://172.18.0.2:30090"
echo "  LocalStack:         http://localhost:4566"
echo ""
echo "  Next steps for demo:"
echo "  1. Verify app: curl http://localhost:30000"
echo "  2. Verify dashboard: curl http://localhost:4000/healthz"
echo "  3. Trigger pipeline on 'main' (shows G1 blocking)"
echo "  4. Trigger pipeline on 'green-test' (shows all 8 gates green)"
echo ""
echo "  See docs/DEMO.md for the full rehearsed demo script."
echo "============================================================"

# Clean up temp kubeconfig
rm -f "$KUBECONFIG_FILE"
