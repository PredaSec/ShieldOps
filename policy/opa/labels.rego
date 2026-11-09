package main

import rego.v1

# =============================================================================
# Policy: Required Labels on Kubernetes Resources
#
# Every Deployment (and its pod template) must carry the following labels:
#   - app         : identifies the application component
#   - team/managed-by : owning team / tooling identifier
#   - environment/env : deployment environment
#
# Gate: G5 (OPA / Conftest)
# Targets: V8 — missing labels in base Helm values
# =============================================================================

has_team_label(labels) if {
  labels.team
}

has_team_label(labels) if {
  labels["managed-by"]
}

has_env_label(labels) if {
  labels.environment
}

has_env_label(labels) if {
  labels.env
}

# Deployment metadata must have 'app' label
deny contains msg if {
  input.kind == "Deployment"
  not input.metadata.labels.app
  msg := sprintf(
    "Deployment '%s': missing required label 'app' on Deployment metadata",
    [input.metadata.name]
  )
}

# Deployment metadata must have a team/owner label
deny contains msg if {
  input.kind == "Deployment"
  not has_team_label(input.metadata.labels)
  msg := sprintf(
    "Deployment '%s': missing a team/owner label ('team' or 'managed-by') on Deployment metadata",
    [input.metadata.name]
  )
}

# Deployment metadata must have an environment label
deny contains msg if {
  input.kind == "Deployment"
  not has_env_label(input.metadata.labels)
  msg := sprintf(
    "Deployment '%s': missing an environment label ('environment' or 'env') on Deployment metadata",
    [input.metadata.name]
  )
}

# Pod template must have 'app' label
deny contains msg if {
  input.kind == "Deployment"
  not input.spec.template.metadata.labels.app
  msg := sprintf(
    "Deployment '%s': pod template is missing required label 'app'",
    [input.metadata.name]
  )
}

# Pod template must have a team/owner label
deny contains msg if {
  input.kind == "Deployment"
  not has_team_label(input.spec.template.metadata.labels)
  msg := sprintf(
    "Deployment '%s': pod template is missing a team/owner label ('team' or 'managed-by')",
    [input.metadata.name]
  )
}

# Pod template must have an environment label
deny contains msg if {
  input.kind == "Deployment"
  not has_env_label(input.spec.template.metadata.labels)
  msg := sprintf(
    "Deployment '%s': pod template is missing an environment label ('environment' or 'env')",
    [input.metadata.name]
  )
}
