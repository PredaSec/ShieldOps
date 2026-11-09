# IaC Security Policy — ShieldOps G4

## Overview

Gate G4 runs two IaC scanners over `terraform/`:

| Tool | Focus | Output |
|------|-------|--------|
| **Checkov** | Terraform + Dockerfile best-practice checks; broad CIS/NIST coverage | `checkov.json` |
| **tfsec** | Terraform-specific security misconfiguration; deep AWS service checks | `tfsec.json` |

Both scanners run on every push that modifies `.tf` files and on every scheduled
nightly run.  They are also run unconditionally on merge-request pipelines.

## Why both?

Running both provides **defense-in-depth** at the IaC level:

| Capability | Checkov | tfsec |
|-----------|---------|-------|
| AWS S3 encryption | ✅ CKV_AWS_19 | ✅ aws-s3-encryption-customer-key |
| AWS S3 versioning | ✅ CKV_AWS_21 | ✅ aws-s3-enable-versioning |
| AWS S3 public access | ✅ CKV_AWS_20 | ✅ aws-s3-no-public-access-with-acl |
| Secrets Manager rotation | ✅ CKV_AWS_149 | ✅ aws-ssm-secret-use-customer-key |
| Dockerfile: no root | ✅ CKV_DOCKER_8 | ❌ (Terraform only) |
| Custom rules (Python / OPA) | ✅ | ❌ |
| SARIF output | ✅ | ✅ |

Overlap on critical checks (S3 encryption, versioning) ensures that a false
negative from one scanner does not silently miss V7.  Non-overlapping checks
expand total coverage.

## Known finding: V7 — Insecure S3 bucket

**File:** `terraform/main.tf`

The `aws_s3_bucket.shieldops_assets` resource is missing:

1. **Server-side encryption** (`aws_s3_bucket_server_side_encryption_configuration`)
   - Checkov: `CKV_AWS_19` (S3 Bucket has server side encryption)
   - tfsec: `aws-s3-enable-bucket-encryption`

2. **Versioning** (`aws_s3_bucket_versioning`)
   - Checkov: `CKV_AWS_21` (S3 Bucket has versioning enabled)
   - tfsec: `aws-s3-enable-versioning`

3. **Public access block** (`aws_s3_bucket_public_access_block`)
   - Checkov: `CKV_AWS_20`, `CKV_AWS_55`
   - tfsec: `aws-s3-no-public-access-with-acl`

**Fix:**

```hcl
resource "aws_s3_bucket_versioning" "shieldops_assets" {
  bucket = aws_s3_bucket.shieldops_assets.id
  versioning_configuration { status = "Enabled" }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "shieldops_assets" {
  bucket = aws_s3_bucket.shieldops_assets.id
  rule {
    apply_server_side_encryption_by_default { sse_algorithm = "AES256" }
  }
}

resource "aws_s3_bucket_public_access_block" "shieldops_assets" {
  bucket                  = aws_s3_bucket.shieldops_assets.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}
```

## Exit-code policy

| Severity | Action |
|----------|--------|
| CRITICAL | Block pipeline (`--check` Checkov / `--minimum-severity CRITICAL` tfsec with exit 1) |
| HIGH     | Warn (logged to report, pipeline continues) |
| MEDIUM   | Warn |

## Running locally

```bash
# Checkov
checkov -d terraform/ -o json > checkov.json

# tfsec
tfsec terraform/ --format json > tfsec.json

# Both in CI (Docker)
docker run --rm -v $(pwd):/src bridgecrew/checkov -d /src/terraform -o json
docker run --rm -v $(pwd):/src aquasec/tfsec /src/terraform --format json
```

## References

- [Checkov Documentation](https://www.checkov.io/1.Welcome/What%20is%20Checkov.html)
- [tfsec Documentation](https://aquasecurity.github.io/tfsec/)
- [CIS AWS Foundations Benchmark](https://www.cisecurity.org/benchmark/amazon_web_services)
- [AWS S3 Security Best Practices](https://docs.aws.amazon.com/AmazonS3/latest/userguide/security-best-practices.html)
