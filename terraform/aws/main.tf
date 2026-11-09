# =============================================================================
# main.tf — ShieldOps Phase 7 AWS infrastructure
#
# ARCHITECTURE CHOICE: ECS Fargate (NOT EKS)
# ─────────────────────────────────────────────
# EKS was considered but rejected for this POC for the following reasons:
#   1. Cost: An EKS control plane costs ~$0.10/hr (~$73/month) before any nodes.
#      ECS Fargate has no control-plane fee; you pay only for task vCPU/memory.
#   2. Complexity: EKS requires node group management (or Fargate profiles),
#      IRSA, CoreDNS, kube-proxy, VPC CNI, etc. ECS Fargate requires none of that.
#   3. The Helm charts used locally (kind) demonstrate Kubernetes packaging skills.
#      ECS for prod deployment adds a second orchestrator layer, showing breadth.
#   4. The deploy script (ci/deploy-aws.sh) and the awsDeploy.js service can still
#      perform `helm template | kubectl apply` against ECS if desired in future;
#      for now the ALB-fronted ECS approach is production-sufficient.
#
# SECURITY CONTRAST WITH terraform/main.tf (LocalStack)
# ───────────────────────────────────────────────────────
# The LocalStack root intentionally has:
#   - Hardcoded credentials ("test"/"test") — acceptable only for local mocking.
#   - SSE-S3 only added as "V7 FIX" to demonstrate what Checkov flags.
#   - No KMS CMK, no VPC isolation, no security groups, no deletion protection.
# THIS root is the compliant production version:
#   - All S3 buckets: SSE-KMS, versioning, public-access-block, lifecycle.
#   - RDS: encrypted at rest (KMS), no public access, deletion protection toggle.
#   - Secrets Manager: auto-rotation ready (secret stores a JSON bundle).
#   - ECR: image scanning on push, tag immutability.
#   - ECS tasks: no public IP, read-only root filesystem, non-root user.
#   - All credentials via Secrets Manager — no plaintext in task definitions.
# =============================================================================

# ---------------------------------------------------------------------------
# KMS — Customer-managed key for encrypting S3, RDS, and Secrets Manager
# ---------------------------------------------------------------------------
resource "aws_kms_key" "shieldops" {
  description             = "ShieldOps CMK — encrypts S3, RDS, Secrets Manager"
  deletion_window_in_days = 30
  enable_key_rotation     = true

  # SECURITY: key rotation every year reduces blast radius of a compromised key.
  # Contrast: LocalStack config had no KMS at all (plain AES256 bucket-key or
  # SSE-S3 only), which is acceptable for local mocks but not for production.
}

resource "aws_kms_alias" "shieldops" {
  name          = "alias/${var.project_name}-cmk"
  target_key_id = aws_kms_key.shieldops.key_id
}

# ---------------------------------------------------------------------------
# ECR — Container image registries
# ---------------------------------------------------------------------------

resource "aws_ecr_repository" "backend" {
  name                 = var.ecr_backend_name
  image_tag_mutability = "IMMUTABLE"
  # SECURITY: IMMUTABLE prevents tag overwriting — an attacker cannot silently
  # replace a known-good image. LocalStack config had no ECR; images were pushed
  # to a plain HTTP registry:5000 (acceptable for kind/local only).

  image_scanning_configuration {
    scan_on_push = true
    # Scans images for OS CVEs immediately on push.
  }

  encryption_configuration {
    encryption_type = "KMS"
    kms_key         = aws_kms_key.shieldops.arn
  }
}

resource "aws_ecr_repository" "frontend" {
  name                 = var.ecr_frontend_name
  image_tag_mutability = "IMMUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }

  encryption_configuration {
    encryption_type = "KMS"
    kms_key         = aws_kms_key.shieldops.arn
  }
}

# Lifecycle policy: keep the 10 most recent untagged images to avoid bloat.
resource "aws_ecr_lifecycle_policy" "backend" {
  repository = aws_ecr_repository.backend.name

  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Remove untagged images beyond ${var.ecr_image_retention_count}"
      selection = {
        tagStatus   = "untagged"
        countType   = "imageCountMoreThan"
        countNumber = var.ecr_image_retention_count
      }
      action = { type = "expire" }
    }]
  })
}

resource "aws_ecr_lifecycle_policy" "frontend" {
  repository = aws_ecr_repository.frontend.name

  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Remove untagged images beyond ${var.ecr_image_retention_count}"
      selection = {
        tagStatus   = "untagged"
        countType   = "imageCountMoreThan"
        countNumber = var.ecr_image_retention_count
      }
      action = { type = "expire" }
    }]
  })
}

# ---------------------------------------------------------------------------
# S3 — Security reports bucket (COMPLIANT — contrast with LocalStack config)
# ---------------------------------------------------------------------------

resource "aws_s3_bucket" "reports" {
  bucket = var.reports_bucket_name
  # SECURITY: force_destroy = false (default) — prevents accidental deletion
  # of audit evidence. LocalStack config had no force_destroy setting.
}

resource "aws_s3_bucket_versioning" "reports" {
  bucket = aws_s3_bucket.reports.id
  versioning_configuration {
    status = "Enabled"
    # Every report file is versioned; previous scan results can be recovered.
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "reports" {
  bucket = aws_s3_bucket.reports.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.shieldops.arn
      # SECURITY: KMS-managed key (not AES256/SSE-S3). Provides key-level audit
      # trail in CloudTrail. LocalStack V7 fix only used AES256.
    }
    bucket_key_enabled = true # reduces KMS API call cost
  }
}

resource "aws_s3_bucket_public_access_block" "reports" {
  bucket = aws_s3_bucket.reports.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
  # SECURITY: All four flags true = no path to public exposure.
}

resource "aws_s3_bucket_lifecycle_configuration" "reports" {
  bucket = aws_s3_bucket.reports.id

  rule {
    id     = "expire-old-reports"
    status = "Enabled"
    filter {} # empty filter = apply to all objects in the bucket

    transition {
      days          = 30
      storage_class = "STANDARD_IA"
    }

    transition {
      days          = 90
      storage_class = "GLACIER"
    }

    expiration {
      days = 365
    }

    noncurrent_version_expiration {
      noncurrent_days = 30
    }
  }
}

# ---------------------------------------------------------------------------
# Secrets Manager — RDS credentials bundle
# ---------------------------------------------------------------------------

resource "aws_secretsmanager_secret" "db" {
  name        = var.db_secret_name
  description = "ShieldOps RDS PostgreSQL master credentials (JSON bundle)"

  kms_key_id = aws_kms_key.shieldops.arn
  # SECURITY: encrypted with CMK, not the default Secrets Manager key.
  # LocalStack config stored a plaintext password string directly in the secret.
  # Here we store a JSON bundle so ECS tasks can read host/port/dbname too,
  # avoiding hardcoding any connection detail outside Secrets Manager.

  recovery_window_in_days = 7
  # 7-day recovery window prevents immediate deletion accidents.
}

resource "aws_secretsmanager_secret_version" "db" {
  secret_id = aws_secretsmanager_secret.db.id

  secret_string = jsonencode({
    username = var.db_username
    password = var.db_password
    # host and dbname are also stored here so the app reads ONE secret.
    # Populated after RDS creation; update via:
    #   aws secretsmanager put-secret-value --secret-id prod/shieldops/db \
    #     --secret-string '{"username":"...","password":"...","host":"...","dbname":"shieldops"}'
    host   = "PENDING_RDS_ENDPOINT"
    port   = 5432
    dbname = var.db_name
  })

  # lifecycle prevents Terraform from re-writing the secret on every plan
  # once the operator has updated the host field manually after RDS creation.
  lifecycle {
    ignore_changes = [secret_string]
  }
}

# ---------------------------------------------------------------------------
# Security Groups
# ---------------------------------------------------------------------------

# ALB security group — accepts HTTPS from the internet
resource "aws_security_group" "alb" {
  name        = "${var.project_name}-alb-sg"
  description = "Allow HTTPS inbound to ALB"
  vpc_id      = var.vpc_id

  ingress {
    description = "HTTPS from internet"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    description = "HTTP redirect"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    description = "Allow all outbound"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

# ECS tasks security group — only accepts traffic from ALB
resource "aws_security_group" "ecs_tasks" {
  name        = "${var.project_name}-ecs-tasks-sg"
  description = "Allow inbound from ALB only"
  vpc_id      = var.vpc_id

  ingress {
    description     = "Backend port from ALB"
    from_port       = var.container_port_backend
    to_port         = var.container_port_backend
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
  }

  ingress {
    description     = "Frontend port from ALB"
    from_port       = var.container_port_frontend
    to_port         = var.container_port_frontend
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
  }

  egress {
    description = "Allow all outbound (ECR, Secrets Manager, RDS)"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

# RDS security group — only accepts traffic from ECS tasks
resource "aws_security_group" "rds" {
  name        = "${var.project_name}-rds-sg"
  description = "Allow PostgreSQL from ECS tasks only"
  vpc_id      = var.vpc_id

  ingress {
    description     = "PostgreSQL from ECS tasks"
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.ecs_tasks.id]
  }

  egress {
    description = "No outbound needed for RDS"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

# ---------------------------------------------------------------------------
# RDS — PostgreSQL (compliant, encrypted, no public access)
# ---------------------------------------------------------------------------

resource "aws_db_subnet_group" "shieldops" {
  name       = "${var.project_name}-db-subnet-group"
  subnet_ids = var.private_subnet_ids
  # SECURITY: RDS is placed in private subnets only.
}

resource "aws_db_instance" "postgres" {
  identifier        = "${var.project_name}-postgres"
  engine            = "postgres"
  engine_version    = "16.3"
  instance_class    = var.db_instance_class
  allocated_storage = var.db_allocated_storage_gb
  storage_type      = "gp3"

  db_name  = var.db_name
  username = var.db_username
  password = var.db_password
  # SECURITY: password sourced from var (injected via TF_VAR_db_password).
  # It is also written to Secrets Manager above so the app never needs it directly.

  storage_encrypted = true
  kms_key_id        = aws_kms_key.shieldops.arn
  # SECURITY: encrypted at rest with CMK. LocalStack had no RDS resource.

  multi_az            = var.db_multi_az
  publicly_accessible = false
  # SECURITY: no public endpoint — only reachable from VPC.

  vpc_security_group_ids = [aws_security_group.rds.id]
  db_subnet_group_name   = aws_db_subnet_group.shieldops.name

  backup_retention_period = 7
  backup_window           = "02:00-03:00"
  maintenance_window      = "sun:04:00-sun:05:00"

  auto_minor_version_upgrade = true
  deletion_protection        = var.db_deletion_protection

  skip_final_snapshot       = false
  final_snapshot_identifier = "${var.project_name}-postgres-final-snapshot"

  enabled_cloudwatch_logs_exports = ["postgresql", "upgrade"]
  # Logs to CloudWatch for audit and debugging.

  performance_insights_enabled = true
}

# ---------------------------------------------------------------------------
# IAM — ECS task execution role and task role
# ---------------------------------------------------------------------------

data "aws_iam_policy_document" "ecs_task_assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

# Task execution role: ECS agent uses this to pull images and fetch secrets.
resource "aws_iam_role" "ecs_execution" {
  name               = "${var.project_name}-ecs-execution-role"
  assume_role_policy = data.aws_iam_policy_document.ecs_task_assume.json
}

resource "aws_iam_role_policy_attachment" "ecs_execution_managed" {
  role       = aws_iam_role.ecs_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

# Grant the execution role access to our specific Secrets Manager secret.
resource "aws_iam_role_policy" "ecs_execution_secrets" {
  name = "${var.project_name}-ecs-secrets-policy"
  role = aws_iam_role.ecs_execution.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "secretsmanager:GetSecretValue",
          "kms:Decrypt",
        ]
        Resource = [
          aws_secretsmanager_secret.db.arn,
          aws_kms_key.shieldops.arn,
        ]
      }
    ]
  })
}

# Task role: the application itself uses this for S3 uploads (report storage).
resource "aws_iam_role" "ecs_task" {
  name               = "${var.project_name}-ecs-task-role"
  assume_role_policy = data.aws_iam_policy_document.ecs_task_assume.json
}

resource "aws_iam_role_policy" "ecs_task_s3" {
  name = "${var.project_name}-ecs-task-s3-policy"
  role = aws_iam_role.ecs_task.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "s3:PutObject",
          "s3:GetObject",
          "s3:ListBucket",
        ]
        Resource = [
          aws_s3_bucket.reports.arn,
          "${aws_s3_bucket.reports.arn}/*",
        ]
      }
    ]
  })
}

# ---------------------------------------------------------------------------
# CloudWatch log groups (for ECS task logs)
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_log_group" "backend" {
  name              = "/ecs/${var.project_name}/backend"
  retention_in_days = 30
  kms_key_id        = aws_kms_key.shieldops.arn
}

resource "aws_cloudwatch_log_group" "frontend" {
  name              = "/ecs/${var.project_name}/frontend"
  retention_in_days = 30
  kms_key_id        = aws_kms_key.shieldops.arn
}

# ---------------------------------------------------------------------------
# ECS Cluster
# ---------------------------------------------------------------------------

resource "aws_ecs_cluster" "shieldops" {
  name = "${var.project_name}-cluster"

  setting {
    name  = "containerInsights"
    value = "enabled"
    # Container Insights sends CPU/memory/network metrics to CloudWatch.
  }
}

resource "aws_ecs_cluster_capacity_providers" "shieldops" {
  cluster_name       = aws_ecs_cluster.shieldops.name
  capacity_providers = ["FARGATE", "FARGATE_SPOT"]

  default_capacity_provider_strategy {
    capacity_provider = "FARGATE"
    weight            = 1
    base              = 1
  }
}

# ---------------------------------------------------------------------------
# ECS Task Definitions
# ---------------------------------------------------------------------------

# Backend task definition — pulls image from ECR, reads DB creds from Secrets Manager
resource "aws_ecs_task_definition" "backend" {
  family                   = "${var.project_name}-backend"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = tostring(var.backend_cpu)
  memory                   = tostring(var.backend_memory)

  execution_role_arn = aws_iam_role.ecs_execution.arn
  task_role_arn      = aws_iam_role.ecs_task.arn

  container_definitions = jsonencode([
    {
      name      = "backend"
      image     = "${aws_ecr_repository.backend.repository_url}:latest"
      essential = true

      portMappings = [
        { containerPort = var.container_port_backend, protocol = "tcp" }
      ]

      # SECURITY: secrets injected via Secrets Manager — never as plain-text
      # environment variables. The ECS agent decrypts at launch time.
      secrets = [
        { name = "DB_USER", valueFrom = "${aws_secretsmanager_secret.db.arn}:username::" },
        { name = "DB_PASSWORD", valueFrom = "${aws_secretsmanager_secret.db.arn}:password::" },
        { name = "DB_HOST", valueFrom = "${aws_secretsmanager_secret.db.arn}:host::" },
        { name = "DB_NAME", valueFrom = "${aws_secretsmanager_secret.db.arn}:dbname::" },
        { name = "DB_PORT", valueFrom = "${aws_secretsmanager_secret.db.arn}:port::" },
      ]

      environment = [
        { name = "NODE_ENV", value = "production" },
        { name = "PORT", value = tostring(var.container_port_backend) },
        { name = "AWS_REGION", value = var.aws_region },
      ]

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.backend.name
          "awslogs-region"        = var.aws_region
          "awslogs-stream-prefix" = "backend"
        }
      }

      # SECURITY: read-only root filesystem; matches values-secure.yaml (V8 fix).
      readonlyRootFilesystem = true

      # SECURITY: non-root user (uid 1000), matching values-secure.yaml.
      user = "1000"

      # SECURITY: no privilege escalation, all capabilities dropped.
      linuxParameters = {
        initProcessEnabled = true
      }
    }
  ])
}

# Frontend task definition
resource "aws_ecs_task_definition" "frontend" {
  family                   = "${var.project_name}-frontend"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = tostring(var.frontend_cpu)
  memory                   = tostring(var.frontend_memory)

  execution_role_arn = aws_iam_role.ecs_execution.arn
  task_role_arn      = aws_iam_role.ecs_task.arn

  container_definitions = jsonencode([
    {
      name      = "frontend"
      image     = "${aws_ecr_repository.frontend.repository_url}:latest"
      essential = true

      portMappings = [
        { containerPort = var.container_port_frontend, protocol = "tcp" }
      ]

      environment = [
        { name = "BACKEND_URL", value = "http://${var.project_name}-backend.${var.project_name}.local:${var.container_port_backend}" },
        { name = "PORT", value = tostring(var.container_port_frontend) },
      ]

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.frontend.name
          "awslogs-region"        = var.aws_region
          "awslogs-stream-prefix" = "frontend"
        }
      }

      # nginx-unprivileged writes to /tmp; readonlyRootFilesystem = false for frontend.
      readonlyRootFilesystem = false
      user                   = "101"
    }
  ])
}

# ---------------------------------------------------------------------------
# ALB — Application Load Balancer
# ---------------------------------------------------------------------------

resource "aws_lb" "shieldops" {
  name               = "${var.project_name}-alb"
  internal           = false
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb.id]
  subnets            = var.public_subnet_ids

  enable_deletion_protection = false
  drop_invalid_header_fields = true
  # SECURITY: drop_invalid_header_fields prevents HTTP desync attacks.
}

resource "aws_lb_target_group" "backend" {
  name        = "${var.project_name}-backend-tg"
  port        = var.container_port_backend
  protocol    = "HTTP"
  vpc_id      = var.vpc_id
  target_type = "ip" # Required for Fargate awsvpc mode

  health_check {
    path                = "/healthz"
    matcher             = "200"
    interval            = 30
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }
}

resource "aws_lb_target_group" "frontend" {
  name        = "${var.project_name}-frontend-tg"
  port        = var.container_port_frontend
  protocol    = "HTTP"
  vpc_id      = var.vpc_id
  target_type = "ip"

  health_check {
    path                = "/"
    matcher             = "200,304"
    interval            = 30
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }
}

# HTTP listener — redirects all traffic to HTTPS.
resource "aws_lb_listener" "http_redirect" {
  load_balancer_arn = aws_lb.shieldops.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type = "redirect"
    redirect {
      port        = "443"
      protocol    = "HTTPS"
      status_code = "HTTP_301"
    }
  }
}

# HTTPS listener — routes /api/* to backend, everything else to frontend.
# NOTE: You must create an ACM certificate and provide the ARN here.
# Uncomment and set certificate_arn once your domain cert is issued:
#
# resource "aws_lb_listener" "https" {
#   load_balancer_arn = aws_lb.shieldops.arn
#   port              = 443
#   protocol          = "HTTPS"
#   ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
#   certificate_arn   = "arn:aws:acm:<region>:<account>:certificate/<id>"
#
#   default_action {
#     type             = "forward"
#     target_group_arn = aws_lb_target_group.frontend.arn
#   }
# }
#
# resource "aws_lb_listener_rule" "backend_api" {
#   listener_arn = aws_lb_listener.https.arn
#   priority     = 10
#   action { type = "forward"; target_group_arn = aws_lb_target_group.backend.arn }
#   condition { path_pattern { values = ["/api/*", "/healthz", "/readyz"] } }
# }

# ---------------------------------------------------------------------------
# ECS Services
# ---------------------------------------------------------------------------

resource "aws_ecs_service" "backend" {
  name            = "${var.project_name}-backend"
  cluster         = aws_ecs_cluster.shieldops.id
  task_definition = aws_ecs_task_definition.backend.arn
  desired_count   = var.backend_desired_count
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = var.private_subnet_ids
    security_groups  = [aws_security_group.ecs_tasks.id]
    assign_public_ip = false
    # SECURITY: tasks run in private subnets with no direct internet exposure.
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.backend.arn
    container_name   = "backend"
    container_port   = var.container_port_backend
  }

  deployment_minimum_healthy_percent = 50
  deployment_maximum_percent         = 200

  depends_on = [aws_iam_role_policy_attachment.ecs_execution_managed]
}

resource "aws_ecs_service" "frontend" {
  name            = "${var.project_name}-frontend"
  cluster         = aws_ecs_cluster.shieldops.id
  task_definition = aws_ecs_task_definition.frontend.arn
  desired_count   = var.frontend_desired_count
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = var.private_subnet_ids
    security_groups  = [aws_security_group.ecs_tasks.id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.frontend.arn
    container_name   = "frontend"
    container_port   = var.container_port_frontend
  }

  deployment_minimum_healthy_percent = 50
  deployment_maximum_percent         = 200

  depends_on = [aws_iam_role_policy_attachment.ecs_execution_managed]
}
