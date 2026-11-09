#!/usr/bin/env bash
# =============================================================================
# ShieldOps Phase 6 — Observability Stack Install Script
# Deploys Prometheus + Grafana + Loki (via loki-stack) + Falco into the
# `monitoring` namespace on the kind cluster `shieldops-cluster`.
#
# IDEMPOTENT: Uses `helm upgrade --install`, safe to re-run.
# PRE-REQUISITE: All images must be pre-pulled and kind-loaded (see README).
#
# Image loading for kind: docker save | ctr import (NOT kind load docker-image)
# because kind load fails on multi-arch manifests with "content digest not found".
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLUSTER_NAME="shieldops-cluster"
NODE_CONTAINER="shieldops-cluster-control-plane"

# ─── Colours ────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
info()    { echo -e "${GREEN}[INFO]${NC}  $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC}  $*"; }
error()   { echo -e "${RED}[ERROR]${NC} $*" >&2; }
die()     { error "$*"; exit 1; }

# ─── Kubeconfig ─────────────────────────────────────────────────────────────
info "Setting up kubeconfig for cluster: ${CLUSTER_NAME}"
sudo -n kind get kubeconfig --name "${CLUSTER_NAME}" > /tmp/kc-obs
export KUBECONFIG=/tmp/kc-obs

# ─── Verify cluster is reachable ────────────────────────────────────────────
kubectl cluster-info --request-timeout=10s &>/dev/null || die "Cannot reach cluster"
info "Cluster is reachable"

# ─── Image loading function ──────────────────────────────────────────────────
load_image() {
  local img="$1"
  # Check if image is already in kind node
  local short_name
  short_name=$(echo "$img" | sed 's|.*/||' | sed 's|:|-|')
  if sudo -n docker exec "${NODE_CONTAINER}" crictl images 2>/dev/null | grep -q "${short_name%%:*}" 2>/dev/null; then
    info "Image ${img} already in kind node (skipping)"
    return 0
  fi
  info "Loading ${img} into kind node..."
  # Pull if not on host
  sudo -n docker image inspect "$img" &>/dev/null || {
    for attempt in 1 2 3; do
      sudo -n docker pull "$img" && break
      warn "Pull attempt $attempt failed for $img, retrying..."
      sleep 5
    done
  }
  # Load into kind via docker save | ctr import
  sudo -n docker save "$img" | \
    sudo -n docker exec -i "${NODE_CONTAINER}" ctr --namespace=k8s.io images import - 2>&1 | tail -2
}

# ─── Pre-pull all required images ────────────────────────────────────────────
info "=== Pre-loading images into kind node ==="
IMAGES=(
  "quay.io/prometheus/prometheus:v3.12.0"
  "quay.io/prometheus/node-exporter:v1.11.1"
  "registry.k8s.io/kube-state-metrics/kube-state-metrics:v2.19.0"
  "quay.io/prometheus-operator/prometheus-config-reloader:v0.91.0"
  "quay.io/prometheus/pushgateway:v1.11.2"
  "docker.io/grafana/grafana:12.3.1"
  "grafana/loki:2.6.1"
  "docker.io/grafana/promtail:3.5.1"
  "docker.io/falcosecurity/falco:0.44.0"
  "docker.io/falcosecurity/falcoctl:0.13.0"
  "kiwigrid/k8s-sidecar:2.5.0"
)
for img in "${IMAGES[@]}"; do
  load_image "$img"
done

# ─── Helm repos ─────────────────────────────────────────────────────────────
info "Adding Helm repositories..."
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts 2>/dev/null || true
helm repo add grafana https://grafana.github.io/helm-charts 2>/dev/null || true
helm repo add falcosecurity https://falcosecurity.github.io/charts 2>/dev/null || true
helm repo update

# ─── Namespace ──────────────────────────────────────────────────────────────
info "Creating monitoring namespace..."
kubectl create namespace monitoring --dry-run=client -o yaml | kubectl apply -f -

# ─── Dashboard ConfigMaps (provisioned via Grafana sidecar) ──────────────────
info "Creating Grafana dashboard ConfigMaps..."
for dashboard in app-health security-posture pipeline-health; do
  kubectl create configmap "grafana-dashboard-${dashboard}" \
    --from-file="${dashboard}.json=${SCRIPT_DIR}/grafana/dashboards/${dashboard}.json" \
    --namespace monitoring \
    --dry-run=client -o yaml | \
    kubectl label --local -f - grafana_dashboard=1 -o yaml | \
    kubectl apply -f -
done

# ─── 1. Prometheus ───────────────────────────────────────────────────────────
info "=== Installing Prometheus ==="
helm upgrade --install prometheus prometheus-community/prometheus \
  --namespace monitoring \
  --values "${SCRIPT_DIR}/prometheus/values.yaml" \
  --set server.image.pullPolicy=IfNotPresent \
  --set nodeExporter.image.pullPolicy=IfNotPresent \
  --set "kube-state-metrics.image.pullPolicy=IfNotPresent" \
  --set configmapReload.prometheus.image.pullPolicy=IfNotPresent \
  --set pushgateway.enabled=false \
  --set alertmanager.enabled=false \
  --timeout 10m \
  --wait=false

# ─── 2. Loki Stack (Loki + Promtail) ─────────────────────────────────────────
info "=== Installing Loki Stack (Loki + Promtail) ==="
helm upgrade --install loki-stack grafana/loki-stack \
  --namespace monitoring \
  --values "${SCRIPT_DIR}/loki/values.yaml" \
  --timeout 10m \
  --wait=false

# ─── 3. Grafana ──────────────────────────────────────────────────────────────
info "=== Installing Grafana ==="
helm upgrade --install grafana grafana/grafana \
  --namespace monitoring \
  --values "${SCRIPT_DIR}/grafana/values.yaml" \
  --timeout 10m \
  --wait=false

# ─── 4. Falco ────────────────────────────────────────────────────────────────
info "=== Installing Falco ==="
helm upgrade --install falco falcosecurity/falco \
  --namespace monitoring \
  --values "${SCRIPT_DIR}/falco/values.yaml" \
  --timeout 10m \
  --wait=false

# ─── Wait for all pods ───────────────────────────────────────────────────────
info "=== Waiting for monitoring deployments (up to 8m)... ==="
sleep 10
kubectl rollout status deployment/prometheus-server -n monitoring --timeout=8m 2>/dev/null || warn "prometheus-server not ready yet"
kubectl rollout status deployment/grafana -n monitoring --timeout=8m 2>/dev/null || warn "grafana not ready yet"
kubectl rollout status statefulset/loki-stack -n monitoring --timeout=8m 2>/dev/null || \
  kubectl rollout status deployment/loki-stack -n monitoring --timeout=8m 2>/dev/null || \
  warn "loki-stack not ready yet"

# Falco runs as a DaemonSet
kubectl rollout status daemonset/falco -n monitoring --timeout=5m 2>/dev/null || warn "falco daemonset not ready yet"

# ─── Print status ────────────────────────────────────────────────────────────
info "=== Final Pod Status ==="
kubectl get pods -n monitoring

# ─── Node IP and access URLs ─────────────────────────────────────────────────
NODE_IP=$(sudo -n docker inspect "${NODE_CONTAINER}" \
  --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' 2>/dev/null | \
  grep -oE '([0-9]{1,3}\.){3}[0-9]{1,3}' | head -1)

echo ""
echo "════════════════════════════════════════════════════════"
echo "  GRAFANA URL:    http://${NODE_IP}:32000"
echo "  Grafana creds:  admin / shieldops-grafana"
echo "  PROMETHEUS URL: http://${NODE_IP}:30090"
echo ""
echo "  Dashboard URLs:"
echo "  App Health:       http://${NODE_IP}:32000/d/shieldops-app-health"
echo "  Security Posture: http://${NODE_IP}:32000/d/shieldops-security-posture"
echo "  Pipeline Health:  http://${NODE_IP}:32000/d/shieldops-pipeline-health"
echo "════════════════════════════════════════════════════════"
