package main

import rego.v1

# =============================================================================
# Unit tests for namespace.rego
# =============================================================================

_good_container := {
  "name": "app",
  "image": "registry:5000/app:latest",
  "resources": {
    "requests": {"cpu": "100m", "memory": "128Mi"},
    "limits":   {"cpu": "500m", "memory": "256Mi"}
  },
  "securityContext": {
    "runAsNonRoot": true,
    "runAsUser": 1000,
    "allowPrivilegeEscalation": false
  }
}

# TRUE POSITIVE: default namespace is forbidden
test_deny_default_namespace if {
  deny[_] with input as {
    "kind": "Deployment",
    "metadata": {
      "name": "app",
      "namespace": "default",
      "labels": {"app": "app", "env": "dev", "managed-by": "helm"}
    },
    "spec": {
      "template": {
        "metadata": {"labels": {"app": "app", "env": "dev", "managed-by": "helm"}},
        "spec": {"containers": [_good_container]}
      }
    }
  }
}

# TRUE POSITIVE: kube-system is forbidden
test_deny_kube_system_namespace if {
  deny[_] with input as {
    "kind": "Deployment",
    "metadata": {
      "name": "app",
      "namespace": "kube-system",
      "labels": {"app": "app", "env": "dev", "managed-by": "helm"}
    },
    "spec": {
      "template": {
        "metadata": {"labels": {"app": "app", "env": "dev", "managed-by": "helm"}},
        "spec": {"containers": [_good_container]}
      }
    }
  }
}

# TRUE NEGATIVE: development namespace is allowed
test_allow_development_namespace if {
  ns_denials := {msg | deny[msg]; contains(msg, "namespace")}
  count(ns_denials) == 0 with input as {
    "kind": "Deployment",
    "metadata": {
      "name": "app",
      "namespace": "development",
      "labels": {"app": "app", "env": "dev", "managed-by": "helm"}
    },
    "spec": {
      "template": {
        "metadata": {"labels": {"app": "app", "env": "dev", "managed-by": "helm"}},
        "spec": {"containers": [_good_container]}
      }
    }
  }
}

# TRUE NEGATIVE: staging namespace is allowed
test_allow_staging_namespace if {
  ns_denials := {msg | deny[msg]; contains(msg, "namespace")}
  count(ns_denials) == 0 with input as {
    "kind": "Deployment",
    "metadata": {
      "name": "app",
      "namespace": "staging",
      "labels": {"app": "app", "env": "staging", "managed-by": "helm"}
    },
    "spec": {
      "template": {
        "metadata": {"labels": {"app": "app", "env": "staging", "managed-by": "helm"}},
        "spec": {"containers": [_good_container]}
      }
    }
  }
}

# TRUE NEGATIVE: production namespace is allowed
test_allow_production_namespace if {
  ns_denials := {msg | deny[msg]; contains(msg, "namespace")}
  count(ns_denials) == 0 with input as {
    "kind": "Deployment",
    "metadata": {
      "name": "app",
      "namespace": "production",
      "labels": {"app": "app", "env": "prod", "managed-by": "helm"}
    },
    "spec": {
      "template": {
        "metadata": {"labels": {"app": "app", "env": "prod", "managed-by": "helm"}},
        "spec": {"containers": [_good_container]}
      }
    }
  }
}

# TRUE NEGATIVE: Service in staging is allowed
test_allow_service_in_staging if {
  ns_denials := {msg | deny[msg]; contains(msg, "namespace")}
  count(ns_denials) == 0 with input as {
    "kind": "Service",
    "metadata": {
      "name": "my-svc",
      "namespace": "staging",
      "labels": {"app": "app"}
    },
    "spec": {"selector": {"app": "app"}}
  }
}
