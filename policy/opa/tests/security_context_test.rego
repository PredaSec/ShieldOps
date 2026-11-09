package main

import rego.v1

# =============================================================================
# Unit tests for security_context.rego
# =============================================================================

# TRUE POSITIVE: privileged container
test_deny_privileged if {
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
              "limits":   {"cpu": "500m", "memory": "256Mi"}
            },
            "securityContext": {
              "privileged": true,
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

# TRUE POSITIVE: allowPrivilegeEscalation not set (defaults to true)
test_deny_privilege_escalation_not_set if {
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
              "limits":   {"cpu": "500m", "memory": "256Mi"}
            },
            "securityContext": {
              "runAsNonRoot": true,
              "runAsUser": 1000
            }
          }]
        }
      }
    }
  }
}

# TRUE POSITIVE: no securityContext at all
test_deny_no_security_context if {
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
              "limits":   {"cpu": "500m", "memory": "256Mi"}
            }
          }]
        }
      }
    }
  }
}

# TRUE POSITIVE: runs as root (no runAsNonRoot, no runAsUser)
test_deny_runs_as_root if {
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
              "limits":   {"cpu": "500m", "memory": "256Mi"}
            },
            "securityContext": {
              "allowPrivilegeEscalation": false
            }
          }]
        }
      }
    }
  }
}

# TRUE NEGATIVE: fully hardened container
test_allow_hardened_container if {
  sc_denials := {msg | deny[msg]; contains(msg, "securityContext")}
  count(sc_denials) == 0 with input as {
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
            "securityContext": {
              "runAsNonRoot": true,
              "runAsUser": 1000,
              "allowPrivilegeEscalation": false,
              "readOnlyRootFilesystem": true,
              "capabilities": {"drop": ["ALL"]}
            }
          }]
        }
      }
    }
  }
}
