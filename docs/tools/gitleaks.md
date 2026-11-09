# G1 — Gitleaks

## Why chosen

Gitleaks is the de-facto open-source secret-scanning tool for git repositories. It scans the **full git history** (not just the latest commit), which is essential: a secret committed two months ago and then "removed" is still in the git object store and still exploitable if the repo is exposed. Unlike simple regex grep tools, Gitleaks uses RE2-compatible patterns with entropy scoring to reduce false positives.

Version pinned: `zricethezav/gitleaks:v8.18.2`

## What it catches in this project

**V1 — Hardcoded AWS credentials** (`app/backend/src/index.js` lines 12–13)

```js
const AWS_ACCESS_KEY_ID     = 'AKIAIOSFODNN7EXAMPLE';
const AWS_SECRET_ACCESS_KEY = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
```

The `AKIA` prefix is the AWS canonical access key format. Gitleaks matches it with the `generic-api-key` and `aws-access-token` built-in rules.

## Config location

`.gitleaks.toml` at the repository root.

The config customises which rules are enabled and can add allowlist patterns for known-safe strings (e.g. test fixtures). The pipeline passes `--config .gitleaks.toml` explicitly.

## Pipeline policy

- **Stage:** `secrets` (first stage — runs before anything else)
- **allow_failure: false** — any finding blocks the entire pipeline
- **exit-code 1** — Gitleaks exits non-zero if any secret is found
- Report format: JSON (`gitleaks.json`), uploaded to S3 and exposed as a GitLab secret_detection artifact

## Failure mode

On `main` (the vulnerable branch), G1 exits 1 and the pipeline stops immediately. No code is built, no image is pushed, no deployment happens. This is the "shift-left" principle: the cheapest check runs first.

## Remediation for V1

Remove the hardcoded values. Inject credentials at runtime via environment variables or AWS Secrets Manager. In production, use IAM roles (no long-lived keys at all). In LocalStack, the `test`/`test` credentials are injected as pipeline variables — never committed.

## OWASP mapping

A02:2021 — Cryptographic Failures (secret exposure)
