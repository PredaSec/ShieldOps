package main

import rego.v1

# =============================================================================
# Policy: Allowed Image Registries
#
# All container images must be pulled from the approved internal registry
# (registry:5000) or from the curated approved-images list.  Images from
# untrusted public registries (e.g. bare docker.io) are not permitted for
# application workloads.
#
# Approved images (pinned, well-known base images used by infrastructure):
#   - postgres:*    (database — explicitly approved public image)
#
# Gate: G5 (OPA / Conftest)
# =============================================================================

approved_registries := {"registry:5000"}

approved_public_images := {"postgres"}

image_name(image) := name if {
  parts := split(image, ":")
  name  := parts[0]
}

from_approved_registry(image) if {
  registry := approved_registries[_]
  startswith(image, registry)
}

is_approved_public(image) if {
  name := image_name(image)
  approved_public_images[name]
}

image_allowed(image) if {
  from_approved_registry(image)
}

image_allowed(image) if {
  is_approved_public(image)
}

deny contains msg if {
  input.kind == "Deployment"
  container := input.spec.template.spec.containers[_]
  not image_allowed(container.image)
  msg := sprintf(
    "Deployment '%s': container '%s' uses image '%s' which is not from an approved registry. Use registry:5000/... or an approved public image.",
    [input.metadata.name, container.name, container.image]
  )
}

deny contains msg if {
  input.kind == "Deployment"
  container := input.spec.template.spec.initContainers[_]
  not image_allowed(container.image)
  msg := sprintf(
    "Deployment '%s': initContainer '%s' uses image '%s' which is not from an approved registry.",
    [input.metadata.name, container.name, container.image]
  )
}
