# =============================================================================
# outputs.tf — ShieldOps AWS Terraform outputs
#
# These values are consumed by:
#   - ci/deploy-aws.sh  (ECR URLs, cluster name, ALB DNS)
#   - values-aws-prod.yaml  (image repository URLs)
#   - docs/aws-deploy.md  (connection info for operators)
#
# SECURITY: No sensitive values (passwords, secret ARNs) are exposed as plain
# outputs. Credentials are always fetched from Secrets Manager at runtime.
# =============================================================================

output "aws_region" {
  description = "AWS region where resources are deployed."
  value       = var.aws_region
}

output "ecr_backend_url" {
  description = "Full ECR repository URL for the backend image (use as Helm image repository)."
  value       = aws_ecr_repository.backend.repository_url
}

output "ecr_frontend_url" {
  description = "Full ECR repository URL for the frontend image."
  value       = aws_ecr_repository.frontend.repository_url
}

output "ecr_registry_id" {
  description = "ECR registry ID (AWS account ID) — needed for docker login."
  value       = aws_ecr_repository.backend.registry_id
}

output "reports_bucket_name" {
  description = "S3 bucket name for pipeline security reports."
  value       = aws_s3_bucket.reports.bucket
}

output "reports_bucket_arn" {
  description = "ARN of the S3 reports bucket."
  value       = aws_s3_bucket.reports.arn
}

output "db_secret_arn" {
  description = "ARN of the Secrets Manager secret containing RDS credentials."
  value       = aws_secretsmanager_secret.db.arn
  # NOTE: The ARN itself is not sensitive; the value retrieved from the secret is.
}

output "db_instance_endpoint" {
  description = "RDS instance endpoint (host:port). Inject into Secrets Manager 'host' field after creation."
  value       = aws_db_instance.postgres.endpoint
}

output "db_instance_id" {
  description = "RDS instance identifier."
  value       = aws_db_instance.postgres.identifier
}

output "ecs_cluster_name" {
  description = "ECS cluster name — used in deploy-aws.sh and awsDeploy.js."
  value       = aws_ecs_cluster.shieldops.name
}

output "ecs_cluster_arn" {
  description = "ECS cluster ARN."
  value       = aws_ecs_cluster.shieldops.arn
}

output "alb_dns_name" {
  description = "ALB public DNS name. Point your domain CNAME here."
  value       = aws_lb.shieldops.dns_name
}

output "alb_arn" {
  description = "ALB ARN — needed to attach ACM certificate listener."
  value       = aws_lb.shieldops.arn
}

output "kms_key_arn" {
  description = "ShieldOps CMK ARN — needed for any additional resources you add."
  value       = aws_kms_key.shieldops.arn
}

output "ecs_task_role_arn" {
  description = "IAM role ARN assumed by ECS tasks (app role)."
  value       = aws_iam_role.ecs_task.arn
}

output "ecs_execution_role_arn" {
  description = "IAM role ARN used by the ECS agent for image pulls and secret injection."
  value       = aws_iam_role.ecs_execution.arn
}
