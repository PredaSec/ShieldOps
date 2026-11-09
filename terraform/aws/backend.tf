# =============================================================================
# backend.tf — Remote state (S3 + DynamoDB lock)
#
# SETUP INSTRUCTIONS (one-time, before first terraform init):
#
#   1. Create the state bucket (replace <account-id> with your AWS account ID):
#        aws s3api create-bucket \
#          --bucket shieldops-tfstate-<account-id> \
#          --region eu-west-1 \
#          --create-bucket-configuration LocationConstraint=eu-west-1
#
#   2. Enable versioning on the state bucket (allows state recovery):
#        aws s3api put-bucket-versioning \
#          --bucket shieldops-tfstate-<account-id> \
#          --versioning-configuration Status=Enabled
#
#   3. Block all public access on the state bucket:
#        aws s3api put-public-access-block \
#          --bucket shieldops-tfstate-<account-id> \
#          --public-access-block-configuration \
#            BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
#
#   4. Enable SSE-S3 encryption on the state bucket:
#        aws s3api put-bucket-encryption \
#          --bucket shieldops-tfstate-<account-id> \
#          --server-side-encryption-configuration \
#            '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'
#
#   5. Create the DynamoDB lock table:
#        aws dynamodb create-table \
#          --table-name shieldops-tflock \
#          --attribute-definitions AttributeName=LockID,AttributeType=S \
#          --key-schema AttributeName=LockID,KeyType=HASH \
#          --billing-mode PAY_PER_REQUEST \
#          --region eu-west-1
#
#   6. Update the bucket value below (replace placeholder), then:
#        terraform -chdir=terraform/aws init
#
# WHY REMOTE STATE:
#   terraform.tfstate contains resource ARNs and (potentially) sensitive outputs.
#   Committing it to git would leak data and cause team conflicts. The S3 backend
#   keeps state encrypted at rest, versioned, and locked per-operation.
#
# COST NOTE: S3 + DynamoDB PAY_PER_REQUEST costs are negligible (cents/month).
# =============================================================================

terraform {
  backend "s3" {
    # Replace with your actual state bucket name after running step 1 above.
    bucket         = "shieldops-tfstate-REPLACE-ACCOUNT-ID"
    key            = "phase7/terraform.tfstate"
    region         = "eu-west-1"
    dynamodb_table = "shieldops-tflock"
    encrypt        = true
  }
}

# NOTE: This file is intentionally committed without real bucket names.
# The placeholder "REPLACE-ACCOUNT-ID" must be filled in before `terraform init`.
# Alternatively, pass -backend-config on the CLI to avoid editing this file:
#   terraform init \
#     -backend-config="bucket=shieldops-tfstate-$(aws sts get-caller-identity --query Account --output text)"
