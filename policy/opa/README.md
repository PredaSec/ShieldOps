# OPA / Conftest Policies — ShieldOps G5

## Overview

Gate G5 runs [Conftest](https://www.conftest.dev/) (backed by OPA) over the
Helm-rendered Kubernetes manifests. All policies live here as Rego files.

The gate is configured as **soft-fail** (`allow_failure: true` in GitLab CI)
because the policies enforce *best-practice* governance controls that may be
in progress for a release. Violations are captured in `conftest.json` and fed
to the AI analysis stages (G6/G8) for prioritised remediation.

## Policy files

| File | Policy | V8 check |
|------|--------|---------|
| `registry.rego` | Images from approved registries only | Indirect (supply chain) |
| `resources.rego` | CPU + memory requests and limits required | **Direct V8** |
| `labels.rego` | Required labels: `app`, team/`managed-by`, env/`environment` | **Direct V8** |
| `security_context.rego` | No privileged containers; `allowPrivilegeEscalation: false`; non-root user | **Direct V8** |
| `namespace.rego` | Namespace restricted to `development`/`staging`/`production` | Governance |

## Policy rationale

### Registry policy (`registry.rego`)

**Why:** Using images from an uncontrolled public registry (e.g. plain
`nginx:latest` from Docker Hub) is a supply-chain risk. A compromised tag
silently pulls a backdoored image into production. Restricting to the internal
registry (`registry:5000`) ensures images are scanned by G3 before deployment.

**Exception:** `postgres:*` is in the `approved_public_images` allow-list
because it is a well-known, pinned official image used for the database.

### Resources policy (`resources.rego`)

**Why:** Without `resources.limits` a single pod can consume unbounded CPU and
memory, causing a noisy-neighbour Denial-of-Service against other workloads on
the same node. Without `resources.requests` the Kubernetes scheduler cannot
make informed placement decisions, leading to node overcommit. V8 leaves all
three deployments without any resource constraints.

### Labels policy (`labels.rego`)

**Why:** Labels are the primary mechanism for:
- Identifying workloads in monitoring/alerting (Prometheus label selectors).
- Tracing ownership for incident response.
- Cost attribution (which team owns this resource?).
- Environment segmentation (prevent `env: prod` resources in staging).

Required: `app`, a team/owner identifier (`team` or `managed-by`), and an
environment marker (`environment` or `env`). V8 omits all these from the base
values; `values-secure.yaml` adds them.

### Security context policy (`security_context.rego`)

**Why:**

1. **`privileged: true`** shares host namespaces and devices — any container
   escape immediately becomes a full host compromise.
2. **`allowPrivilegeEscalation: false`** prevents `setuid` binaries inside
   the container from re-gaining elevated capabilities.
3. **Non-root (`runAsNonRoot: true` / `runAsUser > 0`)** means a process
   takeover gives an attacker only unprivileged access. V5 runs the backend
   as root; V8 does not set `securityContext` on any deployment.

### Namespace policy (`namespace.rego`)

**Why:** Workloads in `kube-system` or `default` bypass the network policies,
RBAC rules, and resource quotas that are scoped to the three approved
namespaces. A misconfigured Helm `values.yaml` could silently deploy to the
wrong namespace if not checked.

## Usage

### Check vulnerable manifests (expect failures)

```bash
helm template shieldops app/helm/shieldops-app \
  -f app/helm/shieldops-app/values-dev.yaml | \
  conftest test -p policy/opa -
```

Expected: 30 failures across backend, frontend, postgres Deployments.

### Check secure manifests (expect pass)

```bash
helm template shieldops app/helm/shieldops-app \
  -f app/helm/shieldops-app/values-dev.yaml \
  -f app/helm/shieldops-app/values-secure.yaml | \
  conftest test -p policy/opa -
```

Expected: 0 failures.

### Run unit tests

```bash
conftest verify -p policy/opa
# Expected: 19 tests, 19 passed
```

### Output JSON report (for CI artifact)

```bash
helm template shieldops app/helm/shieldops-app \
  -f app/helm/shieldops-app/values-dev.yaml | \
  conftest test -p policy/opa --output json - > conftest.json
```

## References

- [OPA Documentation](https://www.openpolicyagent.org/docs/latest/)
- [Conftest Documentation](https://www.conftest.dev/)
- [Kubernetes Security Context](https://kubernetes.io/docs/tasks/configure-pod-container/security-context/)
- [CIS Kubernetes Benchmark](https://www.cisecurity.org/benchmark/kubernetes)
