# G5 — OPA / Conftest

## Why chosen

Open Policy Agent (OPA) with Conftest provides a principled, testable policy-as-code layer for Kubernetes manifests. Unlike ad-hoc shell scripts or Helm linting, Rego policies are:
- **Declarative:** state what is required, not how to check it
- **Testable:** `conftest verify` runs unit tests against the policies themselves
- **Composable:** each policy file is independent and can be evolved separately

Conftest renders Helm templates into plain YAML, then feeds each document to OPA. This catches misconfigurations at template-render time, before `helm install` ever runs.

Version pinned: `openpolicyagent/conftest:v0.57.0`

## Policy files

All policies live in `policy/opa/`. Package: `main`.

### `security_context.rego`

Enforces container security hardening. Every container in a Deployment must:
1. Not be `privileged: true`
2. Set `allowPrivilegeEscalation: false` explicitly
3. Set `runAsNonRoot: true` OR `runAsUser > 0`

Targets V8 (missing securityContext) and V5 (runs as root).

### `resources.rego`

Every container must declare both `resources.requests` and `resources.limits` for CPU and memory. Without limits, a single misbehaving pod can starve all other workloads (noisy-neighbour DoS). Without requests, the Kubernetes scheduler cannot make informed placement decisions.

Targets V8 (no resource limits).

### `labels.rego`

Every Deployment (metadata and pod template) must carry:
- `app` label
- A team/owner label (`team` or `managed-by`)
- An environment label (`environment` or `env`)

Label governance enables Prometheus metric aggregation, RBAC policies, and operational runbooks to work correctly. It also enforces a minimum standard for workload identification.

Targets V8 (missing labels).

### `registry.rego`

Container images must come from:
- The approved internal registry: `registry:5000`
- The explicitly approved public image list: `postgres` (database only)

Any other image source is denied. This prevents supply-chain attacks via unvetted public images and ensures images have been through the G3 Trivy scan (which scans images pushed to `registry:5000`).

### `namespace.rego`

Namespaced resources (Deployment, Service, ConfigMap, PVC, StatefulSet, DaemonSet) must be deployed into one of: `development`, `staging`, `production`. A missing namespace is also denied.

This prevents accidental deployment to system namespaces (e.g. `kube-system`) or typo'd namespace names.

## Soft-fail policy rationale

G5 is `allow_failure: true` — OPA violations log and upload to S3, but do not block the pipeline.

**Why?** The OPA policies enforce a higher standard (fully hardened values) than the minimal viable values used in early environments. The base `values.yaml` intentionally omits securityContext and resource limits (these are the V8 vulnerabilities we are demonstrating). On the `green-test` branch, `values-staging.yaml` is rendered and combined with `values-secure.yaml`, which satisfies all OPA checks. On `main`, OPA produces 30 violations — which are forwarded to the AI analysis service as additional risk signal.

This is a deliberate design choice: OPA violations surface in the AI risk score and can push the recommendation to `BACK_TO_DEV`, but the human operator retains the final decision rather than the policy engine making an automatic block. The hard security boundaries (no secrets, no CVEs) are enforced in G1–G3; G5 enforces operational hygiene standards via soft governance.

## Tests

Test files: `policy/opa/tests/`

- `security_context_test.rego` — 5 test cases (privileged, allowPrivilegeEscalation, runAsNonRoot, combined pass)
- `resources_test.rego` — 4 test cases (missing cpu/memory requests/limits)
- `labels_test.rego` — 4 test cases (missing app/team/env labels)
- `registry_test.rego` — 3 test cases (approved registry, approved public, denied external)
- `namespace_test.rego` — 3 test cases (allowed namespace, denied namespace, missing namespace)

Run locally:

```bash
conftest verify --policy policy/opa
# All tests pass
```

The pipeline also runs `conftest verify --policy policy/opa || true` (non-blocking) to show test results in the CI log.

## Config location

All Rego files: `policy/opa/*.rego`  
Test files: `policy/opa/tests/`  
Pipeline job: `g5-conftest` in `.gitlab-ci.yml`

The Helm chart is rendered with `values-staging.yaml`:

```bash
helm template shieldops app/helm/shieldops-app \
  -f app/helm/shieldops-app/values-staging.yaml \
  --namespace staging \
| conftest test --policy policy/opa --output json --no-fail -
```

## Verified results

- Vulnerable values (base `values.yaml` only): **30 violations** (resource limits + securityContext + labels missing on 3 Deployments)
- Secure values (`values-secure.yaml` applied): **0 violations** (136/136 pass)

## OWASP mapping

A05:2021 — Security Misconfiguration  
A04:2021 — Insecure Design (resource exhaustion / noisy-neighbour)
