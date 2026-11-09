# ShieldOps — End-to-End Demo Script

**Audience:** PFE jury / technical reviewer  
**Duration:** ~25 minutes  
**Narrative:** A developer commits a vulnerable app. The pipeline catches it, the AI advises BACK_TO_DEV. The developer fixes the issues, the pipeline goes green, the AI advises DEPLOY. A human approves, Helm deploys to staging, ZAP scans it, a second AI review gates production. Falco fires live.

---

## Prerequisites (verify before the demo)

```bash
# Confirm cluster is running
sudo -n kind get clusters
# → shieldops-cluster

# Confirm GitLab is up
curl -s http://gitlab.local:8929/-/readiness | python3 -m json.tool | grep status
# → "status": "ok"

# Confirm LocalStack is running (needed for S3 report uploads)
curl -s http://localhost:4566/_localstack/health | python3 -m json.tool | grep s3
# → "s3": "running"

# Confirm dashboard is up
curl -s http://localhost:4000/healthz
# → {"status":"ok"}

# Confirm Grafana is reachable
curl -s -o /dev/null -w "%{http_code}" http://172.18.0.2:32000/login
# → 200
```

If the environment is not clean, run `scripts/demo-reset.sh` first.

---

## Act 1 — Catch the vulnerability (the `main` branch)

**Story:** The developer committing on `main` has left AWS credentials hardcoded in the source. The pipeline catches it at Gate 1 — before any code runs.

### Step 1.1 — Show the vulnerability in the code

Open `app/backend/src/index.js` lines 12–13:

```js
const AWS_ACCESS_KEY_ID     = 'AKIAIOSFODNN7EXAMPLE';
const AWS_SECRET_ACCESS_KEY = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
```

Point out: the key matches the `AKIA` AWS access key pattern that Gitleaks detects.

Also show lines 64–65 (the SQLi):

```js
const sql = "SELECT id, title, description, status, created_at FROM tasks WHERE title ILIKE '%" + keyword + "%' OR description ILIKE '%" + keyword + "%' ORDER BY created_at DESC";
await pool.query(sql);
```

### Step 1.2 — Trigger the pipeline on `main`

Either push a trivial commit, or use the GitLab API to trigger a pipeline manually:

```bash
# Trigger via API (replace <token> with a GitLab project token)
curl --request POST \
  --form "token=<pipeline-trigger-token>" \
  --form "ref=main" \
  "http://gitlab.local:8929/api/v4/projects/1/trigger/pipeline"
```

### Step 1.3 — Watch G1 fail

Navigate to: **http://gitlab.local:8929/root/shieldops/-/pipelines**

- The pipeline shows `G1 secrets` as **failed** (red).
- All downstream stages are skipped.
- Expected console output in the G1 job log:

```
Finding:     Rule: generic-api-key
             Secret: AKIAIOSFODNN7EXAMPLE
             File: app/backend/src/index.js
             Line: 12
[exit code 1]
```

**Jury talking point:** Gitleaks scans the full git history — even if a secret is removed in a later commit, the old commit is still flagged. This is the pre-deployment secret gate.

---

## Act 2 — Show the AI report on the dashboard

**Story:** Before fixing, show how the AI service aggregates findings and presents them on the single pane of glass.

> Note: Because G1 blocks the pipeline on `main`, this act uses a pipeline from the `green-test` branch where we can show a full AI report. The most recent completed pipeline (#25) already has an AI report in S3.

### Step 2.1 — Open the dashboard

Navigate to **http://localhost:8088**

Log in (credentials in `dashboard/.env`, default: admin / the password set during setup).

### Step 2.2 — Show the pipeline list

The dashboard lists recent pipelines ingested via GitLab webhooks. Click on a pipeline that shows BACK_TO_DEV in the AI recommendation column (e.g. a run against `main` that made it past G5).

### Step 2.3 — Show the AI report detail

The pipeline detail view shows:

- Risk score (0–10) and risk level
- Recommendation: `BACK_TO_DEV` (red) or `DEPLOY` (green)
- Rationale paragraph (from Gemini or fallback)
- Top findings table with tool, rule ID, severity, location
- Suggested fixes list
- Per-gate summary

**Jury talking point:** The AI does not block the pipeline — it advises. The human must click **Reject (Back to Dev)** or **Approve**. This is the "AI assists, human decides" philosophy. The AI cannot be tricked into approving a deploy with CRITICAL findings — the `fallback.js` hard-codes `BACK_TO_DEV` when `bySeverity.CRITICAL > 0`, and `gemini.js` applies a safety override at line 179.

---

## Act 3 — Fix the vulnerabilities (switch to `green-test`)

**Story:** The developer applies all the secure variants and pushes to `green-test`. All 8 gates go green.

### What was fixed (show the diff)

```bash
git diff main..green-test -- app/backend/src/index.js | head -60
```

Key changes:
- V1: removed hardcoded AWS key lines → Gitleaks passes
- V2: replaced string concat with parameterised query `$1` → Semgrep passes
- V5: `app/backend/Dockerfile.secure` uses `node:20.14.0-alpine3.20` + `USER node`
- V7: `terraform/main.tf` has encryption, versioning, public-access-block resources
- V8: `app/helm/shieldops-app/values-secure.yaml` adds resources + securityContext

### Step 3.1 — Show the green-test pipeline

Navigate to **http://gitlab.local:8929/root/shieldops/-/pipelines?scope=branches**

Select the `green-test` branch. Pipeline #25 shows all 8 stages green (or trigger a new one).

```bash
# Trigger a fresh pipeline on green-test
curl --request POST \
  --form "token=<pipeline-trigger-token>" \
  --form "ref=green-test" \
  "http://gitlab.local:8929/api/v4/projects/1/trigger/pipeline"
```

Expected per-stage result:

| Stage | Jobs | Result |
|-------|------|--------|
| secrets | g1-secrets | green |
| sast | g2-sast | green |
| sca-image | g3-build-image, g3-trivy-fs, g3-trivy-image | green |
| iac | g4-checkov, g4-tfsec | green |
| policy | g5-conftest | green (soft-fail, 0 violations on secure values) |
| ai-staging | g6-ai-staging-analysis | green → recommendation: DEPLOY |
| ai-staging | g6-deploy-staging | **paused — waiting for human** |

---

## Act 4 — Approve staging deploy and ZAP scan

### Step 4.1 — Review the staging AI report

In the pipeline view, download or view `ai-report-staging.json`:

```json
{
  "recommendation": "DEPLOY",
  "riskScore": 2.5,
  "riskLevel": "LOW",
  "rationale": "No CRITICAL findings. 3 HIGH findings from OPA policy violations on the base values (resource limits). The secure values file resolves these. Safe to deploy to staging.",
  "source": "fallback"
}
```

### Step 4.2 — Click the manual gate

In the GitLab pipeline view, click the play button on **g6-deploy-staging**.

Helm deploys to the `staging` namespace:

```
Release "shieldops" has been upgraded. Happy Helming!
NAME: shieldops
LAST DEPLOYED: ...
NAMESPACE: staging
STATUS: deployed
```

Verify:

```bash
export KUBECONFIG=/tmp/kc
kubectl get pods -n staging
# NAME                                  READY   STATUS    RESTARTS
# shieldops-backend-...                 1/1     Running   0
# shieldops-frontend-...                1/1     Running   0
# shieldops-postgres-...                1/1     Running   0
```

### Step 4.3 — G7 ZAP baseline scan

ZAP automatically starts after the staging deploy. It targets:

```
http://shieldops-cluster-control-plane:30081
```

The baseline scan takes about 3 minutes. Expected output:

```
Total of N alerts. Fail: 0, Warn: N, Ignore: 0, Pass: N
PASS: Content Security Policy
WARN: Missing Anti-clickjacking Header
```

The ZAP job exits 0 (`-I` flag — informational only) and uploads the report to S3.

---

## Act 5 — Promote to production

### Step 5.1 — G8 AI production analysis

G8a aggregates all G1–G7 reports from S3 and runs a second AI review. The production report includes ZAP findings alongside the static scan results.

### Step 5.2 — Approve production deploy

Review `ai-report-prod.json` in the pipeline artifacts, then click **g8-deploy-production** in the pipeline view.

Helm deploys to `production`:

```bash
kubectl get pods -n production
# backend × 2, frontend × 2, postgres × 1 — all Running
```

**Jury talking point:** Notice there are two AI gates — one before staging (G6) and one before production (G8). G8 has the ZAP results in addition to all static scan reports. The human makes the final call both times. The AI recommendation is advisory only, but if it says BACK_TO_DEV, the operator should have a strong reason to override it.

---

## Act 6 — Observe: Grafana dashboards + live Falco alert

### Step 6.1 — Open Grafana

Navigate to **http://172.18.0.2:32000**  
Login: `admin` / `shieldops-grafana`

Go to **Dashboards → ShieldOps** folder:

- **ShieldOps — Application Health**: shows pod counts for development/production, node CPU/memory, and backend logs via Loki.
- **ShieldOps — Pipeline Health**: shows running pods per namespace, replica status.
- **ShieldOps — Security Posture**: shows Falco alert counts over time.

> Known gap: The "HTTP Request Rate" and "Error Rate" panels on App Health show "No data" because the Phase 2 backend does not expose `/metrics` (prom-client not installed). Pod and node panels work correctly.

### Step 6.2 — Trigger a live Falco alert (shell-in-container)

Open a terminal and exec into any running pod:

```bash
export KUBECONFIG=/tmp/kc

# Get a backend pod name
POD=$(kubectl get pods -n production -l app=shieldops-backend -o jsonpath='{.items[0].metadata.name}')

# Exec a shell — this fires the Falco rule
kubectl exec -it "$POD" -n production -- sh
# Type: exit
```

Falco fires immediately (check `kubectl logs -n monitoring -l app.kubernetes.io/name=falco`):

```
Warning eventsource=syscall evt.time=... rule="ShieldOps Shell Spawned in Container"
  Shell spawned inside container user=root container_name=shieldops-backend
  proc=sh parent=... namespace=production pod=shieldops-backend-...
```

In Grafana → Security Posture dashboard, the **Falco Alerts (Total)** counter increments within the Loki scrape interval (~30 seconds).

**Jury talking point:** Falco watches at the kernel system-call level, not the container layer. This means even if an attacker bypasses K8s RBAC and gets `kubectl exec`, Falco still fires. The alert feeds Loki, which Grafana queries — giving the team runtime visibility to complement the pre-deployment security gates.

---

## Appendix A — Demo reset

If you need to restart from a clean state:

```bash
bash scripts/demo-reset.sh
```

See `scripts/demo-reset.sh` for what it resets and what it leaves intact.

---

## Appendix B — Quick URL cheatsheet

| Service | URL | Credentials |
|---------|-----|-------------|
| App (development) | http://localhost:30000 | — |
| GitLab | http://gitlab.local:8929 | root / (set during install) |
| GitLab pipelines | http://gitlab.local:8929/root/shieldops/-/pipelines | — |
| Dashboard | http://localhost:8088 | admin / see dashboard/.env |
| Grafana | http://172.18.0.2:32000 | admin / shieldops-grafana |
| Prometheus | http://172.18.0.2:30090 | — |
| LocalStack S3 console | http://localhost:4566 | test / test |

---

## Appendix C — Vulnerability quick-reference

| Vuln | What to show | Demo payload |
|------|-------------|--------------|
| V1 (secret) | `app/backend/src/index.js` lines 12–13 | — |
| V2 (SQLi) | `app/backend/src/index.js` lines 64–65 | `http://localhost:30000` → search `' OR '1'='1` |
| V4 (XSS) | `app/frontend/index.html` line ~131 | Create task: description = `<img src=x onerror="alert('XSS')">` |
| V8 (OPA) | `app/helm/shieldops-app/values.yaml` | No resource limits, no securityContext |
