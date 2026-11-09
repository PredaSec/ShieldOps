package main

import rego.v1

# =============================================================================
# Policy: Container Security Context Hardening
#
# Every container in a Deployment must satisfy:
#   1. No privileged containers (privileged must not be true).
#   2. allowPrivilegeEscalation must be explicitly false.
#   3. Container must not run as root (runAsNonRoot: true OR runAsUser > 0).
#
# Gate: G5 (OPA / Conftest)
# Targets: V8 — no securityContext in base Helm values; V5 — runs as root
# =============================================================================

runs_as_non_root(container) if {
  container.securityContext.runAsNonRoot == true
}

runs_as_non_root(container) if {
  container.securityContext.runAsUser > 0
}

# 1. Privileged containers are forbidden
deny contains msg if {
  input.kind == "Deployment"
  container := input.spec.template.spec.containers[_]
  container.securityContext.privileged == true
  msg := sprintf(
    "Deployment '%s': container '%s' is running as privileged. Remove securityContext.privileged or set it to false.",
    [input.metadata.name, container.name]
  )
}

# 2. allowPrivilegeEscalation must be explicitly false
deny contains msg if {
  input.kind == "Deployment"
  container := input.spec.template.spec.containers[_]
  not container.securityContext.allowPrivilegeEscalation == false
  msg := sprintf(
    "Deployment '%s': container '%s' must set securityContext.allowPrivilegeEscalation: false",
    [input.metadata.name, container.name]
  )
}

# 3. Container must not run as root
deny contains msg if {
  input.kind == "Deployment"
  container := input.spec.template.spec.containers[_]
  not runs_as_non_root(container)
  msg := sprintf(
    "Deployment '%s': container '%s' must set securityContext.runAsNonRoot: true or securityContext.runAsUser > 0",
    [input.metadata.name, container.name]
  )
}
