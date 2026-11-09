# Trivy Policy — ShieldOps G3

## Overview

Gate G3 runs [Trivy](https://trivy.dev/) as two complementary scans:

1. **`trivy fs`** — filesystem scan over `app/` (dependency SCA + secrets + misconfigurations)
2. **`trivy image`** — image scan of the built backend Docker image

Both scans produce JSON reports uploaded as CI artifacts and pushed to S3.

## Exit-code policy

| Severity  | `trivy fs` | `trivy image` | Rationale |
|-----------|-----------|---------------|-----------|
| CRITICAL  | Exit 1 (blocks) | Exit 1 (blocks) | Publicly exploitable, widely weaponised; must be fixed before deploy |
| HIGH      | Exit 0 (warns) | Exit 0 (warns) | Important but may require coordination with upstream; logs in report |
| MEDIUM+   | Exit 0 (warns) | Exit 0 (warns) | Tracked in report; addressed in next sprint |

Implementation in CI:

```yaml
trivy image --severity CRITICAL --exit-code 1 ...   # blocking job
trivy image --severity HIGH     --exit-code 0 ...   # non-blocking, report only
```

## Known findings (intentional vulnerabilities)

### V5 — Outdated base image: `node:16.14.0-alpine`

| CVE | Component | Severity |
|-----|-----------|---------|
| CVE-2022-0778 | OpenSSL (bundled in node:16.14.0) | CRITICAL |
| CVE-2021-44906 | minimist (transitive dep) | CRITICAL |
| CVE-2022-21680 | marked (transitive dep) | HIGH |

**Fix:** Use `Dockerfile.secure` with `node:20-alpine` (current LTS).

**Risk acceptance:** This image is used in the demo pipeline to show G3
catching real CVEs. It is **not deployed to production**; the cluster
uses `IfNotPresent` and the image is scanned before deployment.

### V6 — Vulnerable dependency: `lodash@4.17.15`

| Advisory | GHSA | Severity |
|----------|------|---------|
| Prototype pollution | GHSA-jf85-cpcp-j695 | HIGH |
| Command injection via template | CVE-2021-23337 | HIGH |
| ReDoS | CVE-2020-28500 | MEDIUM |

**Fix:** Bump to `lodash@^4.17.21` in `package.json`.

**Risk acceptance:** Lodash is only used as a demo vulnerable dependency
(it is imported but not actively called in the task-manager code paths).
The exploit requires calling `_.template()` or `_.merge()` with attacker-
controlled input, which does not occur in the current app routes.

## Suppressed findings (`.trivyignore`)

None currently. Suppressions should be added only with:
1. A valid CVE ID or GHSA ID.
2. A linked Jira/GitLab issue.
3. An expiry date (max 90 days).

Format:
```
# CVE-XXXX-YYYY suppressed until YYYY-MM-DD — linked to issue #123
CVE-XXXX-YYYY
```

## Scanning scope

```
trivy fs --scanners vuln,secret,misconfig app/
trivy image --scanners vuln,secret registry:5000/shieldops-backend:<tag>
```

Secrets scanning (`--scanners secret`) in `trivy fs` provides a secondary
backstop after Gitleaks (G1) for committed credentials in source trees.
Misconfig scanning (`--scanners misconfig`) checks Dockerfile best practices
(e.g. running as root, no HEALTHCHECK, COPY --chown missing).

## References

- [Trivy Documentation](https://trivy.dev/latest/docs/)
- [Trivy Vulnerability Database](https://github.com/aquasecurity/trivy-db)
- [NVD](https://nvd.nist.gov/)
