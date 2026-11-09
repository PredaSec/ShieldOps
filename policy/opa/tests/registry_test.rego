package main

import rego.v1

# =============================================================================
# Unit tests for registry.rego
# =============================================================================

# TRUE POSITIVE: image from unapproved registry (plain nginx from docker hub)
test_deny_docker_hub_image if {
  deny[_] with input as {
    "kind": "Deployment",
    "metadata": {
      "name": "bad-app",
      "namespace": "development",
      "labels": {"app": "bad-app", "env": "dev", "managed-by": "helm"}
    },
    "spec": {
      "template": {
        "metadata": {"labels": {"app": "bad-app", "env": "dev", "managed-by": "helm"}},
        "spec": {
          "containers": [{
            "name": "bad-app",
            "image": "nginx:latest",
            "resources": {
              "requests": {"cpu": "100m", "memory": "128Mi"},
              "limits":   {"cpu": "500m", "memory": "256Mi"}
            },
            "securityContext": {
              "runAsNonRoot": true,
              "runAsUser": 1000,
              "allowPrivilegeEscalation": false
            }
          }]
        }
      }
    }
  }
}

# TRUE POSITIVE: arbitrary external registry
test_deny_arbitrary_registry if {
  deny[_] with input as {
    "kind": "Deployment",
    "metadata": {
      "name": "bad-app",
      "namespace": "development",
      "labels": {"app": "bad-app", "env": "dev", "managed-by": "helm"}
    },
    "spec": {
      "template": {
        "metadata": {"labels": {"app": "bad-app", "env": "dev", "managed-by": "helm"}},
        "spec": {
          "containers": [{
            "name": "bad-app",
            "image": "someregistry.example.com/myapp:1.0",
            "resources": {
              "requests": {"cpu": "100m", "memory": "128Mi"},
              "limits":   {"cpu": "500m", "memory": "256Mi"}
            },
            "securityContext": {
              "runAsNonRoot": true,
              "runAsUser": 1000,
              "allowPrivilegeEscalation": false
            }
          }]
        }
      }
    }
  }
}

# TRUE NEGATIVE: image from internal registry — no registry deny
test_allow_internal_registry if {
  reg_denials := {msg | deny[msg]; contains(msg, "approved registry")}
  count(reg_denials) == 0 with input as {
    "kind": "Deployment",
    "metadata": {
      "name": "backend",
      "namespace": "development",
      "labels": {"app": "backend", "env": "dev", "managed-by": "helm"}
    },
    "spec": {
      "template": {
        "metadata": {"labels": {"app": "backend", "env": "dev", "managed-by": "helm"}},
        "spec": {
          "containers": [{
            "name": "backend",
            "image": "registry:5000/shieldops-backend:latest",
            "resources": {
              "requests": {"cpu": "100m", "memory": "128Mi"},
              "limits":   {"cpu": "500m", "memory": "256Mi"}
            },
            "securityContext": {
              "runAsNonRoot": true,
              "runAsUser": 1000,
              "allowPrivilegeEscalation": false
            }
          }]
        }
      }
    }
  }
}

# TRUE NEGATIVE: postgres is in the approved_public_images list
test_allow_approved_public_postgres if {
  reg_denials := {msg | deny[msg]; contains(msg, "approved registry")}
  count(reg_denials) == 0 with input as {
    "kind": "Deployment",
    "metadata": {
      "name": "postgres",
      "namespace": "development",
      "labels": {"app": "shieldops-postgres", "env": "dev", "managed-by": "helm"}
    },
    "spec": {
      "template": {
        "metadata": {"labels": {"app": "shieldops-postgres", "env": "dev", "managed-by": "helm"}},
        "spec": {
          "containers": [{
            "name": "postgres",
            "image": "postgres:15-alpine",
            "resources": {
              "requests": {"cpu": "200m", "memory": "256Mi"},
              "limits":   {"cpu": "1000m", "memory": "512Mi"}
            },
            "securityContext": {
              "runAsNonRoot": true,
              "runAsUser": 999,
              "allowPrivilegeEscalation": false
            }
          }]
        }
      }
    }
  }
}
