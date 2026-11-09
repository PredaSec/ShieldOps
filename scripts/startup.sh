#!/usr/bin/env bash
# =============================================================================
# ShieldOps — start/restore the whole platform after a reboot.
# Idempotent: safe to re-run. Requires passwordless sudo for docker.
# Usage:  bash scripts/startup.sh
# =============================================================================
set -uo pipefail
cd "$(dirname "$0")/.."        # repo root
ROOT="$(pwd)"
KC=/tmp/kc
say()  { printf '\n\033[1;36m== %s\033[0m\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }

DOCKER="sudo -n docker"

# ---------------------------------------------------------------------------
say "1/8  Docker engine + auto-recovered containers"
$DOCKER info >/dev/null 2>&1 || { warn "docker not reachable (need passwordless sudo). Aborting."; exit 1; }
# Most services have restart policies and are already up; nudge the platform compose.
$DOCKER compose -f docker/docker-compose.yml up -d >/dev/null 2>&1 && ok "platform compose up (gitlab, postgres, localstack, registry)"
$DOCKER compose -f dashboard/docker-compose.yml up -d >/dev/null 2>&1 && ok "dashboard compose up (backend, frontend, db)"

# ---------------------------------------------------------------------------
say "2/8  kind Kubernetes cluster (restart policy is on-failure → start manually)"
if $DOCKER ps --format '{{.Names}}' | grep -q '^shieldops-cluster-control-plane$'; then
  ok "kind node already running"
else
  $DOCKER start shieldops-cluster-control-plane >/dev/null 2>&1 && ok "started kind node" || warn "could not start kind node"
fi

# ---------------------------------------------------------------------------
say "3/8  Wait for the cluster API to be ready"
sudo -n kind get kubeconfig --name shieldops-cluster > "$KC" 2>/dev/null
for i in $(seq 1 40); do
  if KUBECONFIG=$KC kubectl get nodes 2>/dev/null | grep -q ' Ready '; then ok "node Ready  (export KUBECONFIG=$KC)"; break; fi
  sleep 3; [ "$i" = 40 ] && warn "node not Ready after 120s — check 'docker logs shieldops-cluster-control-plane'"
done

# ---------------------------------------------------------------------------
say "4/8  kind node → trust insecure registry:5000 (re-apply, persists across restarts)"
N=shieldops-cluster-control-plane
$DOCKER exec "$N" sh -c '
  grep -q "config_path = \"/etc/containerd/certs.d\"" /etc/containerd/config.toml || printf "\n[plugins.\"io.containerd.grpc.v1.cri\".registry]\n  config_path = \"/etc/containerd/certs.d\"\n" >> /etc/containerd/config.toml
  mkdir -p /etc/containerd/certs.d/registry:5000
  printf "server = \"http://registry:5000\"\n[host.\"http://registry:5000\"]\n  capabilities = [\"pull\", \"resolve\"]\n  skip_verify = true\n" > /etc/containerd/certs.d/registry:5000/hosts.toml
' 2>/dev/null && ok "containerd registry config in place" || warn "could not write containerd config"

# ---------------------------------------------------------------------------
say "5/8  LocalStack is non-persistent → re-provision AWS resources with Terraform"
for i in $(seq 1 20); do $DOCKER exec localstack curl -sf http://localhost:4566/_localstack/health >/dev/null 2>&1 && break; sleep 2; done
( cd terraform && terraform apply -auto-approve -no-color >/dev/null 2>&1 ) && ok "terraform applied (S3 buckets + secret)" \
  || warn "terraform apply had issues — run it manually in terraform/ (see STARTUP.md troubleshooting)"

# ---------------------------------------------------------------------------
say "6/8  Reconnect dashboard backend to the platform network (for GitLab webhooks / CI)"
$DOCKER network connect docker_shieldops-net dashboard-backend >/dev/null 2>&1 && ok "connected" || ok "already connected"

# ---------------------------------------------------------------------------
say "7/8  Regenerate a root API token (/tmp/ci_token.txt — used for push / API / triggering pipelines)"
if $DOCKER exec gitlab test -S /var/opt/gitlab/gitlab-rails/sockets/gitlab.socket 2>/dev/null || $DOCKER exec gitlab gitlab-ctl status puma >/dev/null 2>&1; then
  $DOCKER exec gitlab gitlab-rails runner "
    u = User.find_by_username('root')
    t = u.personal_access_tokens.create!(scopes: ['api','write_repository','read_repository'], name: 'shieldops-ci-'+Time.now.to_i.to_s, expires_at: 365.days.from_now)
    File.write('/tmp/ci_token.txt', t.token.to_s)
  " >/dev/null 2>&1 && $DOCKER cp gitlab:/tmp/ci_token.txt /tmp/ci_token.txt >/dev/null 2>&1 && sudo -n chown "$USER":"$USER" /tmp/ci_token.txt 2>/dev/null && ok "token at /tmp/ci_token.txt" || warn "token gen failed (GitLab may still be booting — retry in a minute)"
else
  warn "GitLab still booting — re-run this step later, or skip if you don't need API/push"
fi

# ---------------------------------------------------------------------------
say "8/8  Health check"
$DOCKER ps --format '{{.Names}}: {{.Status}}' | grep -E 'gitlab|runner|postgres|localstack|registry|dashboard|proxy|cluster-control' | sed 's/^/  /'
echo
KUBECONFIG=$KC kubectl get pods -A 2>/dev/null | grep -E 'development|staging|production|monitoring' | awk '{print "  "$1"/"$2": "$4}' | head -20
echo
printf '  %-22s %s\n' "GitLab:"     "http://localhost:8929   (root / your GitLab root password)"
printf '  %-22s %s\n' "Dashboard:"   "http://localhost:8088   (admin / change_me_strong_password_here)"
printf '  %-22s %s\n' "Grafana:"     "http://localhost:3000   (admin / shieldops-grafana)"
printf '  %-22s %s\n' "Prometheus:"  "http://localhost:9090"
printf '  %-22s %s\n' "App (dev):"   "http://localhost:30000"
echo
ok "Startup complete. If GitLab shows 502, give it 2-3 min to finish booting."
