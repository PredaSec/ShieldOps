# ShieldOps — Architecture

## System components

```mermaid
graph TB
    subgraph Host["Host (Linux) — docker_shieldops-net"]
        GL[GitLab CE<br/>gitlab.local:8929]
        GLR[GitLab Runner<br/>docker-executor]
        LS[LocalStack<br/>S3 + Secrets Mgr<br/>:4566]
        REG[Container Registry<br/>registry:5000]
        PG[App PostgreSQL<br/>:5432]
        DASH[Dashboard<br/>React :8088<br/>Express :4000<br/>Postgres :5434]
    end

    subgraph KIND["kind cluster — shieldops-cluster (172.18.0.2)"]
        subgraph DEV[namespace: development]
            BE_D[backend × 2]
            FE_D[frontend × 2<br/>NodePort 30000]
            PG_D[postgres × 1]
        end
        subgraph STG[namespace: staging]
            BE_S[backend × 1]
            FE_S[frontend × 1<br/>NodePort 30081]
            PG_S[postgres × 1]
        end
        subgraph PROD[namespace: production]
            BE_P[backend × 2]
            FE_P[frontend × 2]
            PG_P[postgres × 1]
        end
        subgraph MON[namespace: monitoring]
            PROM[Prometheus<br/>NodePort 30090]
            GRF[Grafana<br/>NodePort 32000]
            LOKI[Loki + Promtail]
            FALCO[Falco<br/>runtime security]
        end
    end

    GL -- triggers --> GLR
    GLR -- builds via socket --> REG
    GLR -- helm deploy --> KIND
    GLR -- reports --> LS
    GL -- webhooks --> DASH
    DASH -- links out --> GRF
    DASH -- links out --> PROM
    FALCO -- alerts --> LOKI
    LOKI -- logs --> GRF
    PROM -- metrics --> GRF
```

---

## CI/CD pipeline flow

```mermaid
flowchart LR
    PUSH[git push] --> G1

    subgraph SECRETS[Stage: secrets]
        G1[G1 Gitleaks<br/>detect committed secrets]
    end

    subgraph SAST[Stage: sast]
        G2[G2 Semgrep<br/>OWASP + custom SQLi rule]
    end

    subgraph SCA[Stage: sca-image]
        G3B[G3a build-image<br/>docker build + push]
        G3F[G3b trivy-fs<br/>SCA filesystem]
        G3I[G3c trivy-image<br/>Docker image CVEs]
    end

    subgraph IAC[Stage: iac]
        G4C[G4a Checkov<br/>Terraform IaC]
        G4T[G4b tfsec<br/>Terraform IaC]
    end

    subgraph POLICY[Stage: policy]
        G5[G5 OPA/Conftest<br/>Helm manifest governance<br/>SOFT-FAIL]
    end

    subgraph AI_STG[Stage: ai-staging]
        G6A[G6a AI analysis<br/>Gemini / fallback<br/>→ ai-report-staging.json]
        G6D[G6b deploy-staging<br/>MANUAL GATE<br/>Helm → staging]
    end

    subgraph DAST[Stage: dast]
        G7[G7 OWASP ZAP<br/>baseline or full scan<br/>target: staging:30081]
    end

    subgraph AI_PROD[Stage: ai-prod]
        G8A[G8a AI analysis<br/>all G1-G7 reports<br/>→ ai-report-prod.json]
        G8D[G8b deploy-production<br/>MANUAL GATE<br/>Helm → production]
    end

    G1 -->|pass| G2
    G1 -->|fail - secret found| BLOCK1[BLOCKED]
    G2 -->|pass| G3B
    G2 -->|fail - SQLi/SAST| BLOCK2[BLOCKED]
    G3B --> G3F & G3I
    G3F & G3I -->|pass| G4C & G4T
    G4C & G4T --> G5
    G5 -->|always pass - soft-fail| G6A
    G6A --> G6D
    G6D -->|human approves| G7
    G7 --> G8A
    G8A --> G8D
    G8D -->|human approves| DEPLOYED[Production live]

    style BLOCK1 fill:#c00,color:#fff
    style BLOCK2 fill:#c00,color:#fff
    style G5 fill:#f90,color:#000
    style G6D fill:#06c,color:#fff
    style G8D fill:#06c,color:#fff
    style DEPLOYED fill:#090,color:#fff
```

---

## Network topology

```mermaid
graph TD
    subgraph EXT[External / Host]
        BROWSER[Browser<br/>localhost:30000<br/>localhost:8088]
    end

    subgraph DNET[docker_shieldops-net 172.18.0.0/16]
        GL[gitlab.local:8929]
        GLR[gitlab-runner]
        LS[localstack:4566]
        REG[registry:5000]
        PG[postgres:5432]
        DASHBE[dashboard-backend:4000]
        DASHFE[dashboard-frontend:8088]
        KIND_NODE[kind-node: 172.18.0.2]
    end

    BROWSER --> DASHFE
    BROWSER -->|:30000| KIND_NODE
    BROWSER -->|:8929| GL
    DASHFE --> DASHBE
    GL --> GLR
    GLR --> LS
    GLR --> REG
    GLR -->|kubectl/helm| KIND_NODE
    GLR --> DASHBE
```

---

## Namespace layout

| Namespace | Workloads | Notes |
|-----------|-----------|-------|
| `development` | backend × 2, frontend × 2 (NodePort 30000), postgres | Always-on dev environment |
| `staging` | backend × 1, frontend × 1 (NodePort 30081), postgres | Deployed by G6 manual gate; ZAP target |
| `production` | backend × 2, frontend × 2, postgres | Deployed by G8 manual gate |
| `monitoring` | Prometheus, Grafana, Loki, Promtail, Falco | Observability stack; persistent |

---

## Key file paths

| Concern | Path |
|---------|------|
| Pipeline definition | `.gitlab-ci.yml` |
| Helm chart | `app/helm/shieldops-app/` |
| Custom Semgrep rule | `policy/semgrep/custom-rules.yaml` |
| OPA Rego policies | `policy/opa/*.rego` |
| AI service entrypoint | `ai-service/src/index.js` |
| Gemini client | `ai-service/src/gemini.js` |
| Rule-based fallback | `ai-service/src/fallback.js` |
| Dashboard backend | `dashboard/backend/src/` |
| Falco custom rules | `observability/falco/rules.yaml` |
| Grafana dashboards | `observability/grafana/dashboards/` |
| Terraform (LocalStack) | `terraform/main.tf` |
| kind cluster config | `kubernetes/kind-config.yaml` |
| Vulnerability map | `app/VULNERABILITIES.md` |
