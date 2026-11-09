# ShieldOps Phase 6 — Observability Stack

## Overview

This directory contains the Helm values, dashboard JSONs, Falco rules, and install script
for the ShieldOps observability stack deployed into the `monitoring` namespace on the
`shieldops-cluster` kind cluster.

## Components

| Component | Chart | Version | Purpose |
|-----------|-------|---------|---------|
| Prometheus | prometheus-community/prometheus | 29.9.0 | Metrics collection: node, k8s, app |
| Grafana | grafana/grafana | 10.5.15 | 3 provisioned dashboards, visualization |
| Loki + Promtail | grafana/loki-stack | 2.10.3 | Log aggregation from all containers |
| Falco | falcosecurity/falco | 9.0.0 | Runtime security with custom rules |

## Access

| Service | URL | Credentials |
|---------|-----|-------------|
| Grafana | http://172.18.0.2:32000 | admin / shieldops-grafana |
| Prometheus | http://172.18.0.2:30090 | (none) |

> The kind node is reachable from the host at **172.18.0.2** (docker_shieldops-net).
> Grafana is on NodePort 32000, Prometheus on NodePort 30090.
> These are not mapped to localhost — use the node IP directly.

## Dashboards

Three dashboards provisioned under the **ShieldOps** folder in Grafana:

1. **ShieldOps — Application Health** (`uid: shieldops-app-health`)
   - Pod counts (development/production), restarts, node CPU/memory
   - HTTP request rate + error rate panels (requires prom-client on backend — see note)
   - Live backend logs panel via Loki

2. **ShieldOps — Security Posture** (`uid: shieldops-security-posture`)
   - Falco alert counts (total, critical, shell-in-container, sensitive-path)
   - Alert frequency time series
   - Live Falco event log

3. **ShieldOps — Pipeline Health** (`uid: shieldops-pipeline-health`)
   - Running pods by namespace, failed pods, restart rates
   - Deployment replica status table
   - Pipeline webhook event log from dashboard backend

## Falco Custom Rules

File: `falco/rules.yaml` / embedded in `falco/values.yaml`

| Rule | Priority | Trigger |
|------|----------|---------|
| ShieldOps Shell Spawned in Container | WARNING | `sh`/`bash`/etc. exec'd in any container |
| ShieldOps Write to Sensitive Path | ERROR | Write to `/etc`, `/bin`, `/sbin`, `/usr/bin`, `/root` |

## Installation

### Prerequisites

All images must be pre-pulled on the host and loaded into the kind node:

```bash
# Pull and load each image:
for img in \
  "quay.io/prometheus/prometheus:v3.12.0" \
  "quay.io/prometheus/node-exporter:v1.11.1" \
  "registry.k8s.io/kube-state-metrics/kube-state-metrics:v2.19.0" \
  "quay.io/prometheus-operator/prometheus-config-reloader:v0.91.0" \
  "docker.io/grafana/grafana:12.3.1" \
  "grafana/loki:2.6.1" \
  "docker.io/grafana/promtail:3.5.1" \
  "docker.io/falcosecurity/falco:0.44.0" \
  "docker.io/falcosecurity/falcoctl:0.13.0" \
  "kiwigrid/k8s-sidecar:2.5.0"; do
  sudo -n docker pull "$img"
  sudo -n docker save "$img" | sudo -n docker exec -i shieldops-cluster-control-plane \
    ctr --namespace=k8s.io images import -
done
```

### Deploy

```bash
cd observability   # from the repository root
./install.sh
```

### Verify

```bash
kubectl get pods -n monitoring
# Expected: all Running

curl http://172.18.0.2:32000/login        # Grafana
curl -L http://172.18.0.2:30090/          # Prometheus
```

## Known Limitations

- **Backend `/metrics` not implemented**: The Phase 2 backend (Node.js/Express) does not
  include `prom-client`. The App Health dashboard has HTTP rate/error panels that will show
  "No data" until prom-client is added. The pod-status and node-metrics panels work fine.
  To fix: add `prom-client` to `app/backend/`, expose `GET /metrics`, annotate the pod
  with `prometheus.io/scrape: "true"`.

- **Dashboard backend metrics**: The `shieldops-dashboard-backend` Prometheus target is
  `down` because the dashboard backend (port 4000) doesn't expose `/metrics`.

- **Falco alerts on Docker containers**: Falco runs at the host kernel level, so it sees
  ALL containers including Docker Compose ones (GitLab, LocalStack, etc.), not just
  Kubernetes pods. This produces many "Shell spawned" alerts from GitLab health checks.
  The rule can be tightened with `k8s.ns.name != ""` to filter to k8s containers only.

- **loki-stack chart deprecated**: The `grafana/loki-stack` chart is deprecated as of
  Loki 3.x. It is used here because it bundles Loki 2.6.1 + Promtail 3.5.1 in a single
  lightweight release. For production, migrate to `grafana/loki` with SingleBinary mode.

## Phase 5 Dashboard Links

Wire these URLs into the Phase 5 links panel (`GET /api/links`):

| Label | URL |
|-------|-----|
| Grafana | http://172.18.0.2:32000 |
| Prometheus | http://172.18.0.2:30090 |
| Grafana - App Health | http://172.18.0.2:32000/d/shieldops-app-health |
| Grafana - Security Posture | http://172.18.0.2:32000/d/shieldops-security-posture |
| Grafana - Pipeline Health | http://172.18.0.2:32000/d/shieldops-pipeline-health |
