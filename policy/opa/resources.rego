package main

import rego.v1

# =============================================================================
# Policy: Container Resource Requests and Limits
#
# Every container in a Deployment must declare both:
#   - resources.requests.cpu  + resources.requests.memory
#   - resources.limits.cpu    + resources.limits.memory
#
# Without limits a single misbehaving pod can starve all other workloads on the
# node (noisy-neighbour DoS). Without requests the scheduler cannot make
# informed placement decisions.
#
# Gate: G5 (OPA / Conftest)
# Targets: V8 — no resource limits in base Helm values
# =============================================================================

deny contains msg if {
  input.kind == "Deployment"
  container := input.spec.template.spec.containers[_]
  not container.resources.requests.cpu
  msg := sprintf(
    "Deployment '%s': container '%s' is missing resources.requests.cpu",
    [input.metadata.name, container.name]
  )
}

deny contains msg if {
  input.kind == "Deployment"
  container := input.spec.template.spec.containers[_]
  not container.resources.requests.memory
  msg := sprintf(
    "Deployment '%s': container '%s' is missing resources.requests.memory",
    [input.metadata.name, container.name]
  )
}

deny contains msg if {
  input.kind == "Deployment"
  container := input.spec.template.spec.containers[_]
  not container.resources.limits.cpu
  msg := sprintf(
    "Deployment '%s': container '%s' is missing resources.limits.cpu",
    [input.metadata.name, container.name]
  )
}

deny contains msg if {
  input.kind == "Deployment"
  container := input.spec.template.spec.containers[_]
  not container.resources.limits.memory
  msg := sprintf(
    "Deployment '%s': container '%s' is missing resources.limits.memory",
    [input.metadata.name, container.name]
  )
}
