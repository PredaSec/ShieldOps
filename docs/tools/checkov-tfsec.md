# G4 — Checkov + tfsec

## Why chosen

IaC misconfiguration is one of the most common root causes of cloud data breaches (e.g. public S3 buckets, unencrypted storage). Running two complementary tools provides defence in depth:

- **Checkov** (Bridgecrew/Prisma Cloud) — Python-based, rule-driven, excellent for checking against AWS security benchmarks. Produces structured JSON output compatible with the AI analysis service.
- **tfsec** (Aqua Security) — Go-based, fast, excellent at Terraform-specific type inference and module traversal.

Both tools target `terraform/` — the LocalStack IaC that defines the S3 buckets and Secrets Manager resources.

Versions pinned: `bridgecrew/checkov:3.2.33`, `aquasec/tfsec:v1.28.6`

## Config location

No separate config file — policy is expressed as CLI flags in `.gitlab-ci.yml` G4 jobs.

## Checkov policy

```bash
# Two-pass:
# 1. Full soft-fail report → checkov.json (feeds AI analysis)
checkov --directory terraform/ --output json --soft-fail > checkov.json || true

# 2. Gate: targeted S3 controls only (V7 remediation)
checkov \
  --directory terraform/ \
  --check CKV_AWS_19,CKV_AWS_21,CKV_AWS_20,CKV_AWS_55 \
  --output cli
```

Targeted checks:

| Check ID | What it verifies |
|----------|-----------------|
| CKV_AWS_19 | S3 server-side encryption enabled |
| CKV_AWS_21 | S3 versioning enabled |
| CKV_AWS_20 | S3 bucket not publicly readable |
| CKV_AWS_55 | S3 public access block enabled |

## tfsec policy

```bash
# Informational report (non-blocking)
tfsec terraform/ --format json --out tfsec.json --minimum-severity LOW --soft-fail || true

# Gate: CRITICAL only
tfsec terraform/ --minimum-severity CRITICAL --format lovely
```

## Vulnerability caught

**V7 — Insecure S3 bucket** (`terraform/main.tf`)

The vulnerable variant has no encryption, no versioning, and no public-access block. Checkov fires on all four targeted check IDs. The `terraform/main.tf` in the repo is already the remediated version (it was authored with the secure resources), and the `green-test` pipeline passes G4.

The `main` branch was designed with V7 insecurity; see `app/VULNERABILITIES.md` for the details of what the insecure version looks like.

## Why both Checkov and tfsec?

Each has blind spots:
- Checkov has more AWS-specific rules and integrates with the Bridgecrew policy library
- tfsec is faster and handles Terraform module references better
- Running both catches issues that either alone would miss (defence in depth)

This is the same reasoning as using both Trivy filesystem + image scans in G3.

## Trigger rules

Both G4 jobs use conditional triggers — they run on:
- Scheduled pipelines (nightly)
- Merge request events
- Pushes that change `.tf` files or `.gitlab-ci.yml`
- Manual trigger (allow_failure: true so it doesn't break non-IaC PRs)

This avoids running IaC scans on every frontend commit — reducing noise while ensuring IaC changes are always checked.

## OWASP mapping

A05:2021 — Security Misconfiguration
