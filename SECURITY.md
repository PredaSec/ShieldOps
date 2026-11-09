# ShieldOps — Security Model

## Gate to OWASP / Threat mapping

Each of the 8 security gates in ShieldOps targets one or more OWASP Top 10 (2021) categories and specific threat scenarios.

| Gate | Tool | OWASP 2021 | Threat mitigated | Failure mode |
|------|------|-----------|-----------------|--------------|
| G1 Gitleaks | Gitleaks v8.18.2 | A02 Cryptographic Failures | Credential theft via exposed secrets in git history | Hard block |
| G2 Semgrep | Semgrep 1.58.0 | A03 Injection | SQLi (V2), XSS (V4), prototype pollution (V3) | Hard block |
| G3a Trivy FS | Trivy 0.50.1 | A06 Vulnerable and Outdated Components | Exploitable npm packages (lodash CVEs) | CRITICAL blocks |
| G3b Trivy Image | Trivy 0.50.1 | A06 Vulnerable and Outdated Components | OS-level CVEs in container base image | CRITICAL blocks |
| G4a Checkov | Checkov 3.2.33 | A05 Security Misconfiguration | Unencrypted / public-readable S3 buckets | Hard block |
| G4b tfsec | tfsec v1.28.6 | A05 Security Misconfiguration | IaC Terraform CRITICAL misconfigs | Hard block |
| G5 OPA/Conftest | Conftest 0.57.0 | A04 Insecure Design, A05 Security Misconfiguration | Missing resource limits (DoS), running as root, unlabelled workloads | Soft-fail |
| G6 AI Staging | Gemini / fallback | All categories | Aggregates all findings; human-in-the-loop decision before staging | Advisory |
| G7 ZAP | OWASP ZAP stable | A03 Injection, A05, A07 | Live DAST: SQLi/XSS in running app, missing security headers, cookie flags | Informational |
| G8 AI Prod | Gemini / fallback | All categories | Full G1–G7 aggregation including DAST; human-in-the-loop before production | Advisory |

---

## Vulnerability to gate mapping

| Vuln | Description | Gate | Severity |
|------|-------------|------|----------|
| V1 | Hardcoded AWS access key + secret | G1 Gitleaks | CRITICAL |
| V2 | SQL injection (string concat → pool.query) | G2 Semgrep custom rule | CRITICAL |
| V3 | Missing input validation on POST /api/tasks | G2 Semgrep (p/nodejs) | HIGH |
| V4 | DOM XSS via innerHTML | G2 Semgrep + G7 ZAP | HIGH |
| V5 | node:16.14.0-alpine EOL base image, runs as root | G3 Trivy image + G5 OPA | HIGH |
| V6 | lodash@4.17.15 (prototype pollution CVEs) | G3 Trivy FS | HIGH |
| V7 | Unencrypted S3 bucket, no versioning | G4 Checkov + tfsec | MEDIUM |
| V8 | No resource limits, no securityContext, missing labels | G5 OPA/Conftest | MEDIUM |

---

## Defence-in-depth layers

```
Layer 1 — Pre-commit prevention
  G1 Gitleaks: secrets never enter the repo

Layer 2 — Static analysis (build time)
  G2 Semgrep: injection patterns caught in source
  G3 Trivy:   known CVEs caught before image ships
  G4 Checkov/tfsec: IaC misconfigs caught before infra applies

Layer 3 — Policy governance (deploy time)
  G5 OPA/Conftest: manifests must meet K8s security standards
              before reaching the cluster

Layer 4 — AI risk aggregation (pre-deploy)
  G6/G8 AI service: cross-gate risk scoring and
                    deploy/reject recommendation

Layer 5 — Dynamic testing (runtime — staging)
  G7 ZAP: live DAST confirms static findings and catches
          runtime-only issues (headers, cookies)

Layer 6 — Runtime monitoring (production)
  Falco: syscall-level detection of post-deployment
         intrusion attempts
  Prometheus/Grafana: metrics visibility
  Loki: log aggregation and alerting
```

---

## OWASP Top 10 coverage

| OWASP 2021 | Description | Covered by |
|-----------|-------------|-----------|
| A01 Broken Access Control | — | Partially — G7 ZAP can detect unprotected endpoints |
| A02 Cryptographic Failures | Exposed secrets, weak encryption | G1 Gitleaks, G4 Checkov (S3 encryption) |
| A03 Injection | SQLi, XSS, command injection | G2 Semgrep (custom + p/owasp), G7 ZAP |
| A04 Insecure Design | No resource limits (DoS) | G5 OPA resources.rego |
| A05 Security Misconfiguration | IaC misconfig, container runs as root, missing headers | G4 Checkov/tfsec, G5 OPA, G7 ZAP |
| A06 Vulnerable Components | Outdated npm packages, EOL base image | G3 Trivy FS + Image |
| A07 Auth Failures | Cookie flags (HttpOnly/Secure/SameSite) | G7 ZAP baseline |
| A08 Software Integrity | Untrusted image registries | G5 OPA registry.rego |
| A09 Security Logging | — | Falco + Loki + Grafana (observability layer) |
| A10 SSRF | — | G2 Semgrep (p/nodejs includes SSRF patterns) |

---

## Threat model — what is in scope

ShieldOps is a local-cluster proof-of-concept targeting these threats:

1. **Insider threat / developer mistake** — accidentally committed credential, unparameterised SQL query, forgotten `npm update`. The pipeline catches these automatically before they reach any environment.

2. **Supply-chain attack** — malicious or outdated npm package, compromised base image. G3 Trivy blocks on known CRITICAL CVEs; G5 OPA enforces the approved image registry.

3. **IaC drift** — S3 bucket accidentally made public or encryption removed. G4 Checkov/tfsec catches this on every `.tf` change.

4. **Container escape** — process in a pod spawns a shell, writes to system directories, or opens unexpected outbound connections. Falco fires on all three patterns at the kernel level.

5. **Deployment of un-reviewed code** — no human has reviewed the risk. The two manual gates (G6/G8) with AI report summaries ensure a human is always in the loop.

## What is out of scope (documented, not addressed)

- Authentication / authorisation in the app itself (V3 input validation is flagged but no auth framework is added)
- Network policies (no Kubernetes NetworkPolicy resources)
- mTLS between services
- Real-AWS deployment (Phase 7 IaC exists but no AWS account)
- Compliance frameworks (SOC 2, PCI-DSS, ISO 27001 mapping)
