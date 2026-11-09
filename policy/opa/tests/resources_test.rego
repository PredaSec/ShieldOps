package main

import rego.v1

# =============================================================================
# Unit tests for resources.rego
# =============================================================================

# TRUE POSITIVE: missing CPU request
test_deny_missing_cpu_request if {
  deny[_] with input as {
    "kind": "Deployment",
    "metadata": {
      "name": "test-deploy",
      "namespace": "development",
      "labels": {"app": "test-app", "env": "dev", "managed-by": "helm"}
    },
    "spec": {
      "template": {
        "metadata": {"labels": {"app": "test-app", "env": "dev", "managed-by": "helm"}},
        "spec": {
          "containers": [{
            "name": "app",
            "image": "registry:5000/app:latest",
            "resources": {
              "requests": {"memory": "128Mi"},
              "limits":   {"cpu": "500m", "memory": "256Mi"}
            },
            "securityContext": {"runAsNonRoot": true, "runAsUser": 1000, "allowPrivilegeEscalation": false}
          }]
        }
      }
    }
  }
}

# TRUE POSITIVE: missing memory limit
test_deny_missing_memory_limit if {
  deny[_] with input as {
    "kind": "Deployment",
    "metadata": {
      "name": "test-deploy",
      "namespace": "development",
      "labels": {"app": "test-app", "env": "dev", "managed-by": "helm"}
    },
    "spec": {
      "template": {
        "metadata": {"labels": {"app": "test-app", "env": "dev", "managed-by": "helm"}},
        "spec": {
          "containers": [{
            "name": "app",
            "image": "registry:5000/app:latest",
            "resources": {
              "requests": {"cpu": "100m", "memory": "128Mi"},
              "limits":   {"cpu": "500m"}
            },
            "securityContext": {"runAsNonRoot": true, "runAsUser": 1000, "allowPrivilegeEscalation": false}
          }]
        }
      }
    }
  }
}

# TRUE POSITIVE: no resources block at all
test_deny_no_resources if {
  deny[_] with input as {
    "kind": "Deployment",
    "metadata": {
      "name": "test-deploy",
      "namespace": "development",
      "labels": {"app": "test-app", "env": "dev", "managed-by": "helm"}
    },
    "spec": {
      "template": {
        "metadata": {"labels": {"app": "test-app", "env": "dev", "managed-by": "helm"}},
        "spec": {
          "containers": [{
            "name": "app",
            "image": "registry:5000/app:latest",
            "securityContext": {"runAsNonRoot": true, "runAsUser": 1000, "allowPrivilegeEscalation": false}
          }]
        }
      }
    }
  }
}

# TRUE NEGATIVE: full resources set — no resource denials
test_allow_full_resources if {
  resource_denials := {msg | deny[msg]; contains(msg, "resources.")}
  count(resource_denials) == 0 with input as {
    "kind": "Deployment",
    "metadata": {
      "name": "test-deploy",
      "namespace": "development",
      "labels": {"app": "test-app", "env": "dev", "managed-by": "helm"}
    },
    "spec": {
      "template": {
        "metadata": {"labels": {"app": "test-app", "env": "dev", "managed-by": "helm"}},
        "spec": {
          "containers": [{
            "name": "app",
            "image": "registry:5000/app:latest",
            "resources": {
              "requests": {"cpu": "100m", "memory": "128Mi"},
              "limits":   {"cpu": "500m", "memory": "256Mi"}
            },
            "securityContext": {"runAsNonRoot": true, "runAsUser": 1000, "allowPrivilegeEscalation": false}
          }]
        }
      }
    }
  }
}
