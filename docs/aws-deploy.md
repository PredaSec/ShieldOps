# AWS Deployment Guide — ShieldOps Phase 7

## Overview

Phase 7 provisions real AWS infrastructure via Terraform (`terraform/aws/`) and
deploys the ShieldOps app through two trigger paths:

1. **GitLab CI** — the `deploy-aws` job fires after G8 (AI) manual approval gate.
2. **Dashboard AWS Console** — the Phase 5 deployment console at
   `http://localhost:8088` lets operators supply credentials, run a preflight
   check, and click Deploy.

Both paths invoke the **same script**: `ci/deploy-aws.sh`.

---

## Architecture: ECS Fargate (not EKS)

ECS Fargate was chosen over EKS for this POC:

| Factor      | ECS Fargate                     | EKS                                    |
|-------------|---------------------------------|----------------------------------------|
| Cost        | No control-plane fee            | ~$73/month control plane before nodes  |
| Complexity  | No node groups, no CNI plugins  | Node groups, IRSA, CoreDNS, kube-proxy |
| Breadth     | Shows two orchestrators         | (kind already used locally)            |

Run `terraform destroy` when finished to avoid charges (see below).

---

## One-time Bootstrap (before first apply)

### 1. Create the Terraform remote-state bucket

```bash
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
REGION=eu-west-1

aws s3api create-bucket \
  --bucket "shieldops-tfstate-${ACCOUNT_ID}" \
  --region "${REGION}" \
  --create-bucket-configuration LocationConstraint="${REGION}"

aws s3api put-bucket-versioning \
  --bucket "shieldops-tfstate-${ACCOUNT_ID}" \
  --versioning-configuration Status=Enabled

aws s3api put-public-access-block \
  --bucket "shieldops-tfstate-${ACCOUNT_ID}" \
  --public-access-block-configuration \
    BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true

aws s3api put-bucket-encryption \
  --bucket "shieldops-tfstate-${ACCOUNT_ID}" \
  --server-side-encryption-configuration \
    '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'

aws dynamodb create-table \
  --table-name shieldops-tflock \
  --attribute-definitions AttributeName=LockID,AttributeType=S \
  --key-schema AttributeName=LockID,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST \
  --region "${REGION}"
```

### 2. Update backend.tf

Edit `terraform/aws/backend.tf` and replace `shieldops-tfstate-REPLACE-ACCOUNT-ID`
with the bucket name from step 1:

```
bucket = "shieldops-tfstate-<your-account-id>"
```

Or use a `-backend-config` flag at init time to avoid editing the file:

```bash
terraform -chdir=terraform/aws init \
  -backend-config="bucket=shieldops-tfstate-${ACCOUNT_ID}"
```

### 3. Identify your VPC and subnets

The Terraform root requires a pre-existing VPC (the default VPC works for a POC):

```bash
# Default VPC
VPC_ID=$(aws ec2 describe-vpcs --filters Name=isDefault,Values=true \
  --query 'Vpcs[0].VpcId' --output text)

# All subnets in the default VPC (use some as public, some as private)
aws ec2 describe-subnets --filters Name=vpc-id,Values="${VPC_ID}" \
  --query 'Subnets[*].[SubnetId,AvailabilityZone,MapPublicIpOnLaunch]' \
  --output table
```

---

## Supplying Credentials

**NEVER commit credentials to version control.**

### Option A — Environment variables (local apply)

```bash
export AWS_ACCESS_KEY_ID="AKIA..."
export AWS_SECRET_ACCESS_KEY="..."
export AWS_DEFAULT_REGION="eu-west-1"
export TF_VAR_db_password="$(openssl rand -base64 24)"
export TF_VAR_vpc_id="vpc-xxxxxxxx"
export TF_VAR_private_subnet_ids='["subnet-aaa","subnet-bbb"]'
export TF_VAR_public_subnet_ids='["subnet-ccc","subnet-ddd"]'

terraform -chdir=terraform/aws init
terraform -chdir=terraform/aws plan
terraform -chdir=terraform/aws apply
```

### Option B — GitLab masked/protected CI variables

Add the following as **masked + protected** CI variables in
`Settings → CI/CD → Variables`:

| Variable                | Description                          |
|-------------------------|--------------------------------------|
| `AWS_ACCESS_KEY_ID`     | IAM access key ID                    |
| `AWS_SECRET_ACCESS_KEY` | IAM secret key (masked)              |
| `AWS_DEFAULT_REGION`    | e.g. `eu-west-1`                     |
| `TF_VAR_db_password`    | RDS master password (masked)         |
| `TF_VAR_vpc_id`         | VPC ID                               |
| `TF_VAR_private_subnet_ids` | JSON array of private subnet IDs |
| `TF_VAR_public_subnet_ids`  | JSON array of public subnet IDs  |

The `deploy-aws` GitLab job reads these automatically.

### Option C — Dashboard AWS Console (Phase 5)

Navigate to `http://localhost:8088` → **AWS Console** tab. Enter credentials in
the form (they are held in memory only, never persisted to disk or database).
Click **Run Preflight** → if all checks pass, click **Deploy**.

The console calls `dashboard/backend/src/services/awsDeploy.js`, which in turn
invokes `ci/deploy-aws.sh` with credentials injected via `child_process.spawn()`
environment. Log lines stream in real time via SSE.

---

## Running the Terraform Apply

```bash
# Validate first (no credentials needed)
terraform -chdir=terraform/aws validate

# Plan
terraform -chdir=terraform/aws plan -out=tfplan

# Apply (requires real AWS creds in environment)
terraform -chdir=terraform/aws apply tfplan

# Capture outputs for the deploy script
terraform -chdir=terraform/aws output -json > /tmp/tf-outputs.json
```

After apply, update the Secrets Manager `host` field with the RDS endpoint:

```bash
RDS_HOST=$(terraform -chdir=terraform/aws output -raw db_instance_endpoint | cut -d: -f1)
DB_SECRET=$(terraform -chdir=terraform/aws output -raw db_secret_arn)

CURRENT=$(aws secretsmanager get-secret-value --secret-id "${DB_SECRET}" \
  --query SecretString --output text)
UPDATED=$(echo "${CURRENT}" | python3 -c "
import sys,json
s=json.load(sys.stdin)
s['host']='${RDS_HOST}'
print(json.dumps(s))")
aws secretsmanager put-secret-value --secret-id "${DB_SECRET}" --secret-string "${UPDATED}"
```

---

## Running the Deploy Script

```bash
export AWS_ACCESS_KEY_ID="..."
export AWS_SECRET_ACCESS_KEY="..."
export AWS_DEFAULT_REGION="eu-west-1"

# From terraform outputs:
export ECR_BACKEND_URL=$(terraform -chdir=terraform/aws output -raw ecr_backend_url)
export ECR_FRONTEND_URL=$(terraform -chdir=terraform/aws output -raw ecr_frontend_url)
export ECR_REGISTRY=$(echo "${ECR_BACKEND_URL}" | cut -d/ -f1)
export ECS_CLUSTER=$(terraform -chdir=terraform/aws output -raw ecs_cluster_name)
export IMAGE_TAG=$(git rev-parse --short HEAD)

bash ci/deploy-aws.sh
```

---

## Cost Guardrails

Estimated POC cost (eu-west-1, minimal config):

| Resource                  | Monthly cost      |
|---------------------------|-------------------|
| RDS db.t4g.micro          | ~$12–15           |
| ECS Fargate (4 tasks, 256 vCPU / 512 MB) | ~$5–8 |
| ALB                       | ~$16–20           |
| ECR (2 repos, ~1 GB)      | ~$0.10            |
| KMS CMK (1 key)           | $1.00             |
| S3 + Secrets Manager      | <$1               |
| **Total estimate**        | **~$35–45/month** |

### IMPORTANT: destroy when done

```bash
# Destroys ALL resources in terraform/aws/ — run when the demo is complete.
terraform -chdir=terraform/aws destroy

# Verify nothing is left running:
aws ecs list-services --cluster shieldops-cluster
aws rds describe-db-instances --query 'DBInstances[?DBInstanceIdentifier==`shieldops-postgres`]'
```

The S3 reports bucket and ECR repos must be emptied before destroy succeeds:

```bash
aws s3 rm "s3://$(terraform -chdir=terraform/aws output -raw reports_bucket_name)" --recursive
aws ecr delete-repository --repository-name shieldops-backend --force
aws ecr delete-repository --repository-name shieldops-frontend --force
```

Set a **budget alert** in AWS Cost Explorer: `Billing → Budgets → Create budget`
with a $60/month threshold to catch runaway costs.

---

## Local vs AWS Feature Flag

The Phase 5 dashboard switches between local and AWS views via the environment
variable `DEPLOY_TARGET` (set in `dashboard/backend/.env`):

```
# dashboard/backend/.env
DEPLOY_TARGET=local       # shows kind cluster links (Grafana/Prometheus NodePorts)
# DEPLOY_TARGET=aws       # shows ALB DNS + ECR image refs
```

When `DEPLOY_TARGET=aws`, the dashboard AWS Console enables the Deploy button
and the links panel shows the ALB DNS name instead of kind NodePort URLs.

---

## GitLab CI Integration

The `deploy-aws` stage in `.gitlab-ci.yml` runs after G8 manual approval:

```yaml
deploy-aws:
  stage: deploy-aws
  when: manual
  environment:
    name: aws-production
  script:
    - export ECR_BACKEND_URL="${ECR_BACKEND_URL}"
    - export ECR_FRONTEND_URL="${ECR_FRONTEND_URL}"
    - export ECR_REGISTRY="${ECR_REGISTRY}"
    - export ECS_CLUSTER="${ECS_CLUSTER}"
    - export IMAGE_TAG="${CI_COMMIT_SHA:0:8}"
    - bash ci/deploy-aws.sh
  variables:
    # These reference masked/protected CI variables set in GitLab:
    AWS_ACCESS_KEY_ID:     "$AWS_ACCESS_KEY_ID"
    AWS_SECRET_ACCESS_KEY: "$AWS_SECRET_ACCESS_KEY"
    AWS_DEFAULT_REGION:    "$AWS_DEFAULT_REGION"
  rules:
    - if: '$CI_COMMIT_BRANCH == "main"'
      when: manual
```

---

## Security Checklist

- [ ] No credentials in `.gitlab-ci.yml`, `terraform/*.tf`, or any committed file.
- [ ] `TF_VAR_db_password` is masked in GitLab CI variables.
- [ ] `terraform.tfvars` is in `.gitignore`.
- [ ] State bucket has versioning + SSE + public-access-block.
- [ ] RDS `publicly_accessible = false`.
- [ ] All Secrets Manager values read at ECS task start (not in task definition env).
- [ ] Run `checkov -d terraform/aws/` and `tfsec terraform/aws/` before apply.
- [ ] `terraform destroy` run after demo to avoid ongoing charges.
