# ShieldOps Dashboard — Phase 5

Single pane of glass for the ShieldOps DevSecOps pipeline.

## Architecture

```
frontend (React + Vite, port 8088)
    ↓ /api/* proxy
backend (Node/Express, port 4000)
    ↓
dashboard-postgres (PostgreSQL 16, port 5434)
    + → Phase 4 AI service (AI_SERVICE_URL)
    + → GitLab webhooks (POST /api/webhooks/gitlab)
    + → SMTP (Nodemailer)
```

## Quick start (Docker Compose)

```bash
cp .env.example .env
# Edit .env with real values
sudo -n docker compose up -d
# Open http://localhost:8088
```

## Ports (avoids all existing ShieldOps service ports)

| Service              | Host port |
|----------------------|-----------|
| Frontend (nginx)     | **8088**  |
| Backend (Express)    | **4000**  |
| Dashboard PostgreSQL | **5434**  |

## API endpoints

| Method | Path                          | Description                         |
|--------|-------------------------------|-------------------------------------|
| GET    | /api/pipelines                | List recent pipeline runs           |
| GET    | /api/pipelines/:id            | Detail + gates + AI report          |
| POST   | /api/pipelines/:id/approve    | Approve for deployment              |
| POST   | /api/pipelines/:id/reject     | Reject + back-to-dev notification   |
| GET    | /api/reports/:id              | Fetch AI report by ID               |
| POST   | /api/analyze                  | Proxy to Phase 4 AI service         |
| POST   | /api/webhooks/gitlab          | GitLab pipeline webhook receiver    |
| POST   | /api/notifications/send       | Send email notification             |
| GET    | /api/links                    | External tool deep-link URLs        |
| GET    | /api/settings                 | Dashboard settings                  |
| PUT    | /api/settings/:key            | Update a setting                    |
| POST   | /api/auth/login               | Get JWT token                       |
| POST   | /api/aws/validate             | AWS preflight checklist (auth req.) |
| POST   | /api/aws/deploy               | Launch AWS deploy job (auth req.)   |
| GET    | /api/aws/deploy/:jobId        | Job status + SSE log stream         |
| GET    | /healthz                      | Health check                        |
| GET    | /metrics                      | Prometheus metrics                  |

## GitLab webhook setup

1. Go to your GitLab project → Settings → Webhooks.
2. URL: `http://<dashboard-host>:4000/api/webhooks/gitlab`
3. Secret Token: set to the value of `GITLAB_WEBHOOK_TOKEN` in `.env`
4. Trigger: **Pipeline events**

## AWS Deployment Console (section 5.4)

Navigate to **AWS Deploy** in the nav bar.

**Security guarantees:**
- Credentials are type="password" inputs held ONLY in React state (never in localStorage/sessionStorage)
- Deploy button is disabled until all preflight checks pass (backend enforces this by checking allPassed)
- The backend never writes raw credentials to the database or any log line
- Error messages from AWS CLI are passed through `redactAwsError()` which removes the raw secret/session token
- Access Key IDs are masked to `AKIA…****` in all log output
- Temp credentials file (if written) is chmod-600 and deleted in a `finally` block
- JWT auth required on all `/api/aws/*` endpoints
- Rate-limited to 10 req/min per IP

## Development

```bash
# Backend
cd backend && npm install && npm run dev

# Frontend (separate terminal)
cd frontend && npm install && npm run dev
# Vite proxies /api → http://localhost:4000

# Run DB migrations
cd backend && DB_HOST=localhost DB_PORT=5434 node src/db/migrate.js
```

## Running tests

```bash
cd backend && npm test
```

42 tests covering:
- Credential redaction (redactString / redactObject)
- AWS preflight mocked scenarios (valid creds, invalid creds, EKS fail)
- Secret key never appears in preflight detail output
- GitLab webhook token verification + pipeline upsert
- Pipeline list/detail/approve/reject endpoints
- Auth enforcement on /api/aws/* routes
