# ShieldOps — Vulnerability Map (Phase 2)

> Every vulnerability below is **intentional**. This app is a scan target for the
> DevSecOps pipeline. **Do not fix the insecure defaults** — instead, flip to the
> secure variant and re-run the pipeline to show green gates.

---

## Vulnerability table

| # | Vulnerability | File | Line(s) | Pipeline Gate | Severity |
|---|---------------|------|---------|---------------|----------|
| V1 | Hardcoded AWS access key + secret key | `backend/src/index.js` | 12–13 | Gitleaks (G1) | Critical |
| V2 | SQL injection via string concatenation | `backend/src/index.js` | 64–65 | Semgrep custom rule (G2) | Critical |
| V3 | Missing input validation on POST /api/tasks | `backend/src/index.js` | 84–85 | Semgrep (G2) | High |
| V4 | DOM XSS via `innerHTML` (unsanitised description) | `frontend/index.html` | ~107, ~131 | Semgrep / ZAP (G2/G7) | High |
| V5 | Outdated base image (`node:16.14.0-alpine`) + runs as root | `backend/Dockerfile` | 14, 26 | Trivy image scan (G3) | High |
| V6 | Pinned old `lodash@4.17.15` with prototype-pollution CVEs | `backend/package.json` | 11 | Trivy SCA (G3) | High |
| V7 | Insecure S3 bucket (no encryption, no versioning) | `terraform/main.tf` | (Phase 1) | Checkov / tfsec (G4) | Medium |
| V8 | No resource limits, no securityContext, missing labels | `helm/shieldops-app/templates/*.yaml` | (all Deployments) | OPA / Conftest (G5) | Medium |

---

## V1 — Hardcoded AWS credentials

**What:** AWS access key ID and secret key are hardcoded at the top of `index.js`.

**Code (index.js:12–13):**
```js
const AWS_ACCESS_KEY_ID     = 'AKIAIOSFODNN7EXAMPLE';
const AWS_SECRET_ACCESS_KEY = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
```

**Fix:** Remove hardcoded values. Inject at runtime via environment variables or
AWS Secrets Manager (LocalStack). In the pipeline, Gitleaks pre-commit hook blocks
the commit before it reaches the repo.

---

## V2 — SQL Injection

**What:** The `/api/tasks/search` endpoint builds its SQL query by concatenating
the raw user-supplied `keyword` parameter into the query string.

**Code (index.js:64–65):**
```js
const sql = "SELECT ... WHERE title ILIKE '%" + keyword + "%' OR ...";
await pool.query(sql);
```

**Demo payload:** `' OR '1'='1` — returns all rows; `'; DROP TABLE tasks; --` could
destroy data.

**Fix:** Use parameterised queries:
```js
await pool.query("SELECT ... WHERE title ILIKE $1 OR description ILIKE $1", [`%${keyword}%`]);
```

---

## V3 — Missing Input Validation

**What:** `POST /api/tasks` accepts `title`, `description`, and `status` from the
request body without any length, type, or format validation.

**Fix:** Use `express-validator` or `joi` to validate inputs before insertion:
```js
body('title').isString().trim().isLength({ min: 1, max: 255 }),
body('status').isIn(['todo', 'in-progress', 'done']),
```

---

## V4 — DOM XSS via innerHTML

**What:** The frontend renders task descriptions directly via `innerHTML`, allowing
any HTML/script payload stored in the database to execute in the victim's browser.

**Code (index.html:~131):**
```js
<td class="desc-cell">${t.description}</td>   // rendered via innerHTML on parent
```

**Demo payload (create a task with this description):**
```html
<img src=x onerror="alert(document.cookie)">
```

**Fix:** Replace `innerHTML` with `textContent`, or sanitise with DOMPurify:
```js
td.textContent = t.description;
// or
td.innerHTML = DOMPurify.sanitize(t.description);
```

---

## V5 — Outdated Base Image + Runs as Root

**What:** The backend Dockerfile uses `node:16.14.0-alpine` (EOL, multiple CVEs)
and does not set a `USER` directive, so the process runs as root inside the
container.

**Fix:** Use `Dockerfile.secure`:
- Base image: `node:20.14.0-alpine3.20` (current LTS, minimal CVEs).
- Add `USER node` after installing dependencies.

---

## V6 — Vulnerable Dependency

**What:** `backend/package.json` pins `lodash@4.17.15`. Lodash versions before
4.17.21 are affected by prototype-pollution vulnerabilities:
- CVE-2021-23337 (command injection via `_.template`)
- CVE-2020-28500 (ReDoS via `_.trim`)
- GHSA-jf85-cpcp-j695 (prototype pollution)

**Fix:** Bump to `lodash@^4.17.21` in `package.json`.

---

## V7 — Insecure S3 Bucket (Terraform)

**What:** The LocalStack S3 bucket in `terraform/main.tf` is created without
server-side encryption (`server_side_encryption_configuration`) and without
versioning enabled (`versioning { enabled = true }`).

**Fix (in terraform/main.tf):**
```hcl
resource "aws_s3_bucket_versioning" "shieldops" {
  bucket = aws_s3_bucket.shieldops.id
  versioning_configuration { status = "Enabled" }
}
resource "aws_s3_bucket_server_side_encryption_configuration" "shieldops" {
  bucket = aws_s3_bucket.shieldops.id
  rule {
    apply_server_side_encryption_by_default { sse_algorithm = "AES256" }
  }
}
```

---

## V8 — Missing Resource Limits / securityContext / Labels

**What:** All three Helm Deployment templates (`backend`, `frontend`, `postgres`)
omit:
- `resources.requests` and `resources.limits` — OPA denies workloads without
  memory/CPU limits (prevents noisy-neighbour DoS).
- `securityContext` — containers can run as root, with elevated privileges, with
  writable root filesystem.
- Required labels (`app`, `version`, `env`, `managed-by`) — OPA enforces label
  governance.

**Fix:** Apply `values-secure.yaml` on top of the environment values file:
```
helm upgrade --install shieldops-app ./helm/shieldops-app \
  -f values-dev.yaml \
  -f values-secure.yaml \
  -n development
```
All three fields are supplied in `values-secure.yaml` and are conditionally
rendered in the templates via `{{- with ... }}` blocks.

---

## Demo flow (vulnerable → secure)

1. `cd app && sudo docker compose up -d --build` — start the stack.
2. Open `http://localhost:8080`.
3. **V2 demo:** search `' OR '1'='1` — all tasks returned.
4. **V4 demo:** create task with description `<img src=x onerror="alert('XSS')">` — alert fires on reload.
5. Push to GitLab → pipeline runs gates G1–G8 → all findings reported.
6. Fix V1: remove hardcoded credentials, inject via env. Re-push → G1 green.
7. Fix V2: swap string concat for `$1` param. Re-push → G2 green.
8. Use `Dockerfile.secure` for backend build → G3 green.
9. Apply `values-secure.yaml` in Helm deploy → G5 green.
