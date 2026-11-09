package main

import rego.v1

# =============================================================================
# Policy: Namespace Restriction
#
# Resources may only be deployed into approved namespaces:
#   - development
#   - staging
#   - production
#
# Gate: G5 (OPA / Conftest)
# =============================================================================

allowed_namespaces := {"development", "staging", "production"}

namespaced_kinds := {
  "Deployment",
  "Service",
  "ConfigMap",
  "PersistentVolumeClaim",
  "StatefulSet",
  "DaemonSet",
}

deny contains msg if {
  namespaced_kinds[input.kind]
  ns := input.metadata.namespace
  not allowed_namespaces[ns]
  msg := sprintf(
    "%s '%s' is deployed to namespace '%s' which is not in the allowed list %v",
    [input.kind, input.metadata.name, ns, allowed_namespaces]
  )
}

deny contains msg if {
  namespaced_kinds[input.kind]
  not input.metadata.namespace
  msg := sprintf(
    "%s '%s' has no namespace set. Must be one of: development, staging, production.",
    [input.kind, input.metadata.name]
  )
}
