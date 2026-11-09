# G7 — OWASP ZAP

## Why chosen

OWASP ZAP (Zed Attack Proxy) is the leading open-source Dynamic Application Security Testing (DAST) tool. Unlike SAST (which analyses source code), DAST actually sends HTTP requests to the running application and observes responses. This means it catches:
- Issues that only appear at runtime (e.g. server-side header misconfigurations)
- Vulnerabilities in rendered HTML that SAST cannot see (e.g. missing CSP headers)
- SQL injection and XSS that survive sanitisation bugs in the code

ZAP is authoritative for V4 (DOM XSS) because the XSS only manifests when the browser renders the page — SAST can flag the `innerHTML` pattern but ZAP confirms the actual HTTP response contains the payload.

Image: `ghcr.io/zaproxy/zaproxy:stable`

## Two scan modes

### Baseline scan (every non-scheduled pipeline)

```yaml
zap-baseline.py
  -t "${STAGING_URL}"   # http://shieldops-cluster-control-plane:30081
  -J zap-report.json
  -r zap-report.html
  -I                    # informational only — exit 0 even with warnings
  -m 3                  # spider for 3 minutes
```

Passive rules only — no active attacks. Scans the staging frontend for:
- Missing security headers (CSP, X-Frame-Options, HSTS)
- Information disclosure (server version headers)
- Cookie flags (HttpOnly, Secure, SameSite)

Duration: ~3–5 minutes.

### Full scan (nightly schedule only)

```yaml
zap-full-scan.py
  -t "${STAGING_URL}"
  -J zap-full-report.json
  -r zap-full-report.html
  -I
```

Active attack mode — sends crafted payloads to find SQL injection, XSS, path traversal, etc. This is the scan that would catch V2 and V4 on the vulnerable branch.

Only runs on scheduled pipelines (`CI_PIPELINE_SOURCE == "schedule"`) to avoid hammering staging on every commit.

## Config location

No separate ZAP config file. All settings are CLI flags in `.gitlab-ci.yml` G7 jobs.

Target URL: `STAGING_URL: "http://shieldops-cluster-control-plane:30081"` (defined in global pipeline variables). This is the kind cluster node DNS name, reachable from ZAP because both run on `docker_shieldops-net`.

## Pipeline position

G7 runs **after** the G6 manual deploy gate — it requires a running staging deployment. ZAP scans the same artifact that was just deployed by Helm, providing end-to-end assurance: the code was scanned statically (G2), the images were scanned for CVEs (G3), the IaC was scanned (G4), the manifests were policy-checked (G5), and now the live app is scanned dynamically (G7).

The ZAP report (`zap-report.json`) is uploaded to S3 and downloaded by G8a (AI production analysis), where Gemini/fallback incorporates the DAST findings into the production risk score.

## Non-blocking design

Both ZAP jobs use `-I` (informational mode) — they never fail the pipeline. This is a policy choice: ZAP baseline scans commonly generate medium/low findings (missing headers) that are legitimate operational decisions (e.g. the app may intentionally not set HSTS in a local dev cluster). Blocking on ZAP findings would make the pipeline permanently red in local environments where TLS and production-grade headers are not configured.

The ZAP findings feed the G8 AI analysis, which factors them into the production risk score. A high ZAP finding count will lower the `DEPLOY` confidence or switch the recommendation to `BACK_TO_DEV`.

## OWASP mapping

A03:2021 — Injection (SQLi, XSS — active detection)  
A05:2021 — Security Misconfiguration (missing headers)  
A07:2021 — Identification and Authentication Failures (cookie flags)
