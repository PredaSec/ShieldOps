# =============================================================================
# variables.tf — ShieldOps AWS Terraform root
#
# All sensitive values (passwords, keys) must be supplied via:
#   - terraform.tfvars (gitignored)
#   - TF_VAR_* environment variables (preferred for CI)
# Never commit real values to version control.
# =============================================================================

variable "aws_region" {
  description = "AWS region for all resources."
  type        = string
  default     = "eu-west-1"
}

variable "environment" {
  description = "Deployment environment tag (production / staging)."
  type        = string
  default     = "production"
}

variable "project_name" {
  description = "Short project identifier; used in resource names and tags."
  type        = string
  default     = "shieldops"
}

# ---------------------------------------------------------------------------
# ECR
# ---------------------------------------------------------------------------
variable "ecr_backend_name" {
  description = "ECR repository name for the backend image."
  type        = string
  default     = "shieldops-backend"
}

variable "ecr_frontend_name" {
  description = "ECR repository name for the frontend image."
  type        = string
  default     = "shieldops-frontend"
}

variable "ecr_image_retention_count" {
  description = "Number of untagged images to retain in each ECR repo."
  type        = number
  default     = 10
}

# ---------------------------------------------------------------------------
# S3 (reports bucket)
# ---------------------------------------------------------------------------
variable "reports_bucket_name" {
  description = "Globally unique S3 bucket name for pipeline security reports."
  type        = string
  default     = "shieldops-reports-prod"
}

# ---------------------------------------------------------------------------
# Secrets Manager
# ---------------------------------------------------------------------------
variable "db_secret_name" {
  description = "Secrets Manager secret name that stores RDS credentials."
  type        = string
  default     = "prod/shieldops/db"
}

# ---------------------------------------------------------------------------
# RDS
# ---------------------------------------------------------------------------
variable "db_instance_class" {
  description = "RDS instance class. db.t4g.micro is sufficient for the POC and Free Tier eligible."
  type        = string
  default     = "db.t4g.micro"
}

variable "db_name" {
  description = "Initial database name."
  type        = string
  default     = "shieldops"
}

variable "db_username" {
  description = "RDS master username."
  type        = string
  default     = "shieldops"
  sensitive   = true
}

variable "db_password" {
  description = <<-EOT
    RDS master password. Supply via TF_VAR_db_password environment variable.
    Must be at least 16 characters. Never set a default here.
  EOT
  type        = string
  sensitive   = true
  # No default — operator MUST supply this.
}

variable "db_allocated_storage_gb" {
  description = "Initial RDS allocated storage in GB."
  type        = number
  default     = 20
}

variable "db_multi_az" {
  description = "Enable RDS Multi-AZ for HA. Set false for POC to save cost."
  type        = bool
  default     = false
}

variable "db_deletion_protection" {
  description = "Prevent accidental RDS deletion. Set true for real production."
  type        = bool
  default     = false
}

# ---------------------------------------------------------------------------
# VPC / networking (must exist before apply — provide via tfvars or use
# the data sources below)
# ---------------------------------------------------------------------------
variable "vpc_id" {
  description = "ID of the VPC in which ECS tasks and RDS will run."
  type        = string
  # No default — must be provided.
}

variable "private_subnet_ids" {
  description = "List of private subnet IDs for ECS tasks and RDS."
  type        = list(string)
  # No default — must be provided.
}

variable "public_subnet_ids" {
  description = "List of public subnet IDs for the ALB."
  type        = list(string)
  # No default — must be provided.
}

# ---------------------------------------------------------------------------
# ECS Fargate
# ---------------------------------------------------------------------------
variable "backend_cpu" {
  description = "Fargate vCPU units for the backend task (256 = 0.25 vCPU)."
  type        = number
  default     = 256
}

variable "backend_memory" {
  description = "Fargate memory in MiB for the backend task."
  type        = number
  default     = 512
}

variable "frontend_cpu" {
  description = "Fargate vCPU units for the frontend task."
  type        = number
  default     = 256
}

variable "frontend_memory" {
  description = "Fargate memory in MiB for the frontend task."
  type        = number
  default     = 512
}

variable "backend_desired_count" {
  description = "Number of backend ECS tasks."
  type        = number
  default     = 2
}

variable "frontend_desired_count" {
  description = "Number of frontend ECS tasks."
  type        = number
  default     = 2
}

variable "container_port_backend" {
  description = "Container port for the backend service."
  type        = number
  default     = 3001
}

variable "container_port_frontend" {
  description = "Container port for the frontend service."
  type        = number
  default     = 8080
}
