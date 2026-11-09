# ShieldOps — Startup / Restore After Reboot

Everything runs in Docker on this machine. After you turn the PC back on and log
in, **run one script** and you're back up.

```bash
cd shieldops   # repository root
bash scripts/startup.sh
```

That's it. The rest of this doc explains what it does and how to fix things if a
step misbehaves.

---

## What happens on reboot (auto vs. manual)

| Component | On reboot | Why |
|-----------|-----------|-----|
| GitLab, GitLab Runner | ✅ auto (restart `always`) | |
| Postgres, LocalStack, Registry | ✅ auto (`unless-stopped`) | |
| Dashboard (backend/frontend/db) | ✅ auto (`unless-stopped`) | |
| Grafana/Prometheus proxies | ✅ auto (`unless-stopped`) | |
| **kind Kubernetes cluster** | ❌ **manual start** | restart policy is `on-failure`, so a clean shutdown does NOT restart it |
| **LocalStack data** (S3 bucket, secret) | ❌ **gone** | LocalStack community is non-persistent → Terraform re-apply |
| **kubeconfig** (`/tmp/kc`), **API token** (`/tmp/ci_token.txt`) | ❌ **wiped** | `/tmp` clears on reboot → regenerated |
| In-cluster workloads (app, observability) | ✅ auto once the cluster starts | stored in the cluster's etcd (persists on the node volume) |

`scripts/startup.sh` handles all the ❌ items for you, in order, and waits where needed.

---

## Access (after startup)

| Service | URL | Credentials |
|---------|-----|-------------|
| GitLab | http://localhost:8929 | `root` / the password you set on first GitLab start |
| ShieldOps Dashboard | http://localhost:8088 | `admin` / `change_me_strong_password_here` |
| Grafana | http://localhost:3000 | `admin` / `shieldops-grafana` |
| Prometheus | http://localhost:9090 | — |
| App (dev namespace) | http://localhost:30000 | — |

> Grafana/Prometheus are reached via small `socat` proxy containers (`grafana-proxy`,
> `prometheus-proxy`) because the kind NodePorts (`32000`/`30090`) only bind the
> docker-internal IP, not `localhost`. The proxies auto-start.

---

## Verify it's healthy

```bash
export KUBECONFIG=/tmp/kc
sudo docker ps --format '{{.Names}}: {{.Status}}'      # all containers up
kubectl get pods -A | grep -E 'development|staging|production|monitoring'   # all Running
sudo docker exec localstack awslocal s3 ls             # shieldops-assets-bucket + shieldops-reports
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8929   # GitLab (200/302 once booted)
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8088/  # Dashboard 200
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3000/login  # Grafana 200
```

---

## Manual fallback (if you ever need to do it by hand)

```bash
# 1. start the kind cluster (the one thing that won't auto-start)
sudo docker start shieldops-cluster-control-plane
sudo kind get kubeconfig --name shieldops-cluster > /tmp/kc
export KUBECONFIG=/tmp/kc
kubectl get nodes              # wait for Ready

# 2. nudge the compose stacks (no-op if already up)
sudo docker compose -f docker/docker-compose.yml up -d
sudo docker compose -f dashboard/docker-compose.yml up -d
sudo docker network connect docker_shieldops-net dashboard-backend   # ignore "already exists"

# 3. re-create the LocalStack AWS resources
cd terraform && terraform apply -auto-approve && cd ..
```

---

## Troubleshooting

- **GitLab shows 502 / won't log in for a few minutes** — normal; GitLab takes
  2–3 min to fully boot. Wait and retry. Check: `sudo docker exec gitlab gitlab-ctl status`.
- **`terraform apply` says "secret already exists"** — LocalStack kept a partial
  state. Fix:
  ```bash
  sudo docker exec localstack awslocal secretsmanager delete-secret \
    --secret-id prod/db_password --force-delete-without-recovery
  cd terraform && terraform apply -auto-approve
  ```
- **kind node won't start** — `sudo docker logs shieldops-cluster-control-plane`.
  Worst case recreate the cluster (you'd then re-deploy via `scripts/`/Helm and
  re-run Terraform).
- **A pipeline re-pulls tool images slowly the first time** — expected; the image
  cache was pruned to free disk. It's a one-time cost per image.
- **Dashboard can't reach the AI service** — the AI analysis runs inside the
  pipeline (CI), not as a long-running service; the dashboard only needs the
  reports, which CI posts via `POST /api/reports/ingest`.
- **`/tmp/ci_token.txt` missing** — re-run `scripts/startup.sh` step 7, or create a
  Personal Access Token in the GitLab UI (Settings → Access Tokens, scope `api`).

---

## Clean shutdown (optional, before powering off)

Nothing special is required — just power off; restart policies + this script handle
recovery. If you want a graceful stop:

```bash
sudo docker compose -f dashboard/docker-compose.yml stop
sudo docker compose -f docker/docker-compose.yml stop
sudo docker stop shieldops-cluster-control-plane
```
(They'll all be brought back by `scripts/startup.sh` on next login.)
