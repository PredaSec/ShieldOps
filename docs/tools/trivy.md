# G3 — Trivy

## Why chosen

Trivy (Aqua Security) is a single-binary vulnerability scanner that covers filesystem dependencies (SCA), Docker image layers, secrets, and misconfigurations in one tool. Its comprehensive OS package database (Alpine, Debian, Ubuntu) and language manifest scanning (npm, pip, Go modules) mean it catches CVEs that language-specific tools miss. The container image scan in particular catches base-OS CVEs that `npm audit` cannot see.

Version pinned: `aquasec/trivy:0.50.1`

## Three jobs in the `sca-image` stage

### G3a — `g3-build-image` (Docker build)

Builds the backend and frontend images using the host Docker daemon (socket-mounted into the runner container — no dind needed). Pushes to `registry:5000`.

```yaml
image: docker:24.0.6
# DOCKER_BUILDKIT: "0"  — legacy builder avoids IPv6 flakiness with pinned base images
```

Images tagged: `registry:5000/shieldops-backend:${CI_PIPELINE_IID}` and the `latest` alias.

### G3b — `g3-trivy-fs` (filesystem SCA)

Scans the `app/` directory for:
- Vulnerable npm dependencies (package-lock.json)
- Embedded secrets
- Dockerfile misconfigurations

Two runs:
1. `--severity CRITICAL,HIGH,MEDIUM --exit-code 0` — full report, non-blocking, feeds the AI analysis
2. `--severity CRITICAL --exit-code 1` — **gate**: only CRITICAL blocks

### G3c — `g3-trivy-image` (Docker image scan)

Scans `${BACKEND_IMAGE}` for OS-package CVEs in the Alpine base image layers.

Two runs:
1. `--severity CRITICAL --exit-code 1` — **gate**: CRITICAL CVEs block the pipeline
2. `--severity CRITICAL,HIGH,MEDIUM --exit-code 0` — full report for AI analysis

## Policy rationale: CRITICAL-only blocks

**Why not block on HIGH?** A pragmatic risk decision. A mature team would progressively tighten this, but early in a project HIGH findings in transitive dependencies are common and often have no fix available (`--ignore-unfixed` is set). Blocking on every HIGH would make the pipeline permanently red and train developers to ignore alerts. The tiered approach:

- CRITICAL → immediate block (exploitable, fix available)
- HIGH → recorded in the AI analysis report; AI factors it into the risk score
- MEDIUM → informational

This aligns with NIST SP 800-61 incident triage philosophy: not all vulnerabilities are equally exploitable.

## Vulnerabilities caught

| Vuln | Caught by | Severity |
|------|-----------|----------|
| V5 — `node:16.14.0-alpine` (EOL, OpenSSL CVEs) | g3-trivy-image | HIGH |
| V6 — `lodash@4.17.15` (prototype pollution) | g3-trivy-fs | HIGH |

The secure fix (Dockerfile.secure) uses `node:20.14.0-alpine3.20` + `USER node` which reduces the CVE count to zero CRITICAL findings.

## Config location

No separate config file — all policy is expressed as CLI flags in `.gitlab-ci.yml` G3 jobs. Cache directory: `.trivycache/` (GitLab cache key `trivy-db-cache`).

## OWASP mapping

A06:2021 — Vulnerable and Outdated Components
