terraform {
  required_version = ">= 1.5"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

# ---------------------------------------------------------------------------
# Real-AWS provider — credentials injected via environment variables only.
#
# Contrast with terraform/main.tf (LocalStack root):
#   - LocalStack root hard-codes access_key = "test" + custom endpoints to
#     redirect to localhost:4566. That is intentional for the local POC.
#   - THIS root NEVER hard-codes credentials. The AWS provider picks them up
#     from the standard env-var chain:
#       AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_SESSION_TOKEN
#     or from an IAM instance-profile when running on EC2/ECS/GitLab OIDC.
#   - skip_* flags and custom endpoints are absent here — we want real AWS API
#     validation, STS, and metadata.
# ---------------------------------------------------------------------------
provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project     = "ShieldOps"
      Environment = var.environment
      ManagedBy   = "Terraform"
      Phase       = "7"
    }
  }
}
