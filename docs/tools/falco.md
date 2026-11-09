# Falco — Runtime Security

## Why chosen

Falco (CNCF) watches Linux system calls at the kernel level using eBPF/kernel module drivers. This means it detects threats that:
- Bypass container-level controls (e.g. an attacker who has `kubectl exec` but no file-system writes still generates system calls)
- Cannot be caught at build time (you cannot statically analyse whether someone will exec a shell at runtime)
- Occur in any running container — Kubernetes pods, Docker Compose services, and any process on the host

Falco is the runtime complement to the pipeline's pre-deployment gates. Gates G1–G5 prevent known bad code from deploying. Falco catches what slips through or arrives via zero-day/supply-chain attacks post-deployment.

Helm chart version: `falcosecurity/falco:9.0.0`  
Falco image: `docker.io/falcosecurity/falco:0.44.0`

## Deployment

Deployed to the `monitoring` namespace alongside Prometheus, Grafana, Loki, and Promtail.

```bash
cd observability && ./install.sh
```

## Custom rules

File: `observability/falco/rules.yaml`

### Rule 1 — Shell Spawned in Container (WARNING)

```yaml
condition: >
  spawned_process and container
  and proc.name in (sh, bash, ash, dash, ksh, zsh, fish)
  and not proc.pname in (sh, bash, ash, ...)
```

Fires when a shell binary is executed inside any container. A shell spawn in a production container is almost always anomalous — legitimate app containers have no shell in their process tree. This rule is the primary indicator for container breakout / lateral movement.

**Demo trigger:** `kubectl exec -it <pod> -n production -- sh`

### Rule 2 — Unexpected Outbound Connection (NOTICE)

Fires when a container opens an outbound TCP connection to an IP not in the allowed range (loopback, RFC-1918, known cluster ports). Indicates potential C2 beacon or data exfiltration.

Exceptions are made for well-known tools (`curl`, `wget`, `git`, `node`, `npm`, `pip`, `python`) to avoid alert fatigue during container startup and dependency installation.

### Rule 3 — Write to Sensitive Path (ERROR)

Fires when a container writes to `/etc`, `/bin`, `/sbin`, `/usr/bin`, `/usr/local/bin`, or `/root`. These directories should be immutable in production containers. Writes here indicate persistence mechanisms (backdooring system binaries) or privilege escalation.

Excluded: package managers (`apk`, `apt`, `npm`, `pip`) — they legitimately write to these paths during image build but should not appear in production.

### Rule 4 — Privileged Container Started (CRITICAL)

Fires when a container starts with `privileged: true` in a ShieldOps application namespace (`development`, `staging`, `production`). The OPA G5 policy prevents privileged containers from being deployed; this rule catches any that slip through (e.g. emergency manual patches).

## Integration with Grafana

Falco events are captured by Promtail (log agent), forwarded to Loki, and visualised in the **ShieldOps — Security Posture** dashboard:
- `uid: shieldops-security-posture` at `http://172.18.0.2:32000/d/shieldops-security-posture`
- Panel: "Falco Alerts (Total)" — LogQL count of Falco WARNING/ERROR events
- Panel: "Falco Event Log" — live event stream from Loki

## Known limitations

- Falco watches at the host kernel level and sees ALL containers (Docker Compose services included — GitLab, LocalStack, etc.), not just Kubernetes pods. The `ShieldOps Shell Spawned in Container` rule fires frequently on GitLab health-check processes. Filter to K8s-only by adding `k8s.ns.name != ""` to the condition.
- The `allowed_outbound_destination` macro in Rule 2 is deliberately broad to avoid noise in the local environment. Tighten for production use.

## MITRE ATT&CK mapping

| Rule | MITRE Tactic | MITRE Technique |
|------|-------------|-----------------|
| Shell in container | Execution | T1059 — Command and Scripting Interpreter |
| Outbound connection | Exfiltration | T1041 — Exfiltration Over C2 Channel |
| Sensitive path write | Persistence | T1546 — Event-Triggered Execution |
| Privileged container | Privilege Escalation | T1611 — Escape to Host |
