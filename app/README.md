# ShieldOps — Task Manager App (Phase 2)

A deliberately-vulnerable 3-tier task-management application.
**Purpose:** provide real scan findings for every pipeline gate (Phases 3–8).

Stack: Vanilla HTML/JS frontend (nginx) + Node/Express backend + PostgreSQL.

---

## Quick start (local Docker Compose)

```bash
cd app   # from the repository root
sudo docker compose up -d --build
```

- Frontend UI: http://localhost:8080
- Backend API: http://localhost:3001/api/tasks

Wait ~10 s for postgres to initialise, then refresh the UI.

---

## API endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/healthz` | Liveness probe — always 200 |
| GET | `/readyz` | Readiness probe — 200 only when DB is reachable |
| GET | `/api/tasks` | List all tasks (safe, parameterised) |
| GET | `/api/tasks/search?keyword=X` | Search tasks — **V2 SQLi** (string concat) |
| POST | `/api/tasks` | Create task — **V3** no input validation |
| DELETE | `/api/tasks/:id` | Delete task by ID |

---

## Vulnerability demos

### V2 — SQL Injection

1. In the search box, type: `' OR '1'='1`
2. Click Search — every task in the database is returned regardless of the filter.

Via curl:
```bash
curl "http://localhost:3001/api/tasks/search?keyword=%27+OR+%271%27%3D%271"
```

### V4 — Stored XSS via innerHTML

1. In the "Create Task" form, set the **description** to:
   ```
   <img src=x onerror="alert(document.cookie)">
   ```
2. Click **Add Task**.
3. The alert fires immediately (the task list is re-rendered via `innerHTML`).

Via curl:
```bash
curl -s -X POST http://localhost:3001/api/tasks \
  -H 'Content-Type: application/json' \
  -d '{"title":"XSS Test","description":"<img src=x onerror=alert(1)>","status":"todo"}'
```
Then reload http://localhost:8080.

---

## Helm (Kubernetes)

```bash
# Render manifests for dev (requires helm installed)
helm template shieldops ./helm/shieldops-app -f helm/shieldops-app/values-dev.yaml

# Dry-run apply
helm template shieldops ./helm/shieldops-app -f helm/shieldops-app/values-dev.yaml \
  | kubectl apply --dry-run=client -f -

# Deploy to development namespace
helm upgrade --install shieldops ./helm/shieldops-app \
  -f helm/shieldops-app/values-dev.yaml \
  -n development

# Show secure (compliant) variant
helm upgrade --install shieldops ./helm/shieldops-app \
  -f helm/shieldops-app/values-dev.yaml \
  -f helm/shieldops-app/values-secure.yaml \
  -n development
```

---

## Build images and push to local registry

```bash
cd app

# Build
sudo docker build -t registry:5000/shieldops-backend:dev ./backend
sudo docker build -t registry:5000/shieldops-frontend:dev ./frontend

# Push (requires registry:5000 running)
sudo docker push registry:5000/shieldops-backend:dev
sudo docker push registry:5000/shieldops-frontend:dev

# Load into kind cluster
sudo kind load docker-image registry:5000/shieldops-backend:dev --name shieldops-cluster
sudo kind load docker-image registry:5000/shieldops-frontend:dev --name shieldops-cluster
```

---

## Vulnerability map

See [VULNERABILITIES.md](./VULNERABILITIES.md) for the full V1–V8 table and fix instructions.

---

## Directory layout

```
app/
├── database/
│   └── init.sql               # Table schema + seed rows
├── backend/
│   ├── src/index.js           # Express API (V1, V2, V3)
│   ├── package.json           # Dependencies (V6: lodash@4.17.15)
│   ├── Dockerfile             # V5: node:16.14.0-alpine, runs as root
│   ├── Dockerfile.secure      # Fix for V5
│   └── .dockerignore
├── frontend/
│   ├── index.html             # Vanilla JS UI (V4: innerHTML XSS)
│   ├── nginx.conf             # Proxy /api/ → backend:3001
│   ├── Dockerfile
│   └── .dockerignore
├── helm/
│   └── shieldops-app/
│       ├── Chart.yaml
│       ├── values.yaml        # Base (V8: no limits/securityContext)
│       ├── values-dev.yaml
│       ├── values-staging.yaml
│       ├── values-prod.yaml
│       ├── values-secure.yaml # Fix for V8
│       └── templates/
│           ├── configmap-init-sql.yaml
│           ├── backend-deployment.yaml
│           ├── backend-service.yaml
│           ├── frontend-deployment.yaml
│           ├── frontend-service.yaml
│           ├── postgres-deployment.yaml
│           ├── postgres-service.yaml
│           └── postgres-pvc.yaml
├── docker-compose.yml
├── README.md
└── VULNERABILITIES.md
```
