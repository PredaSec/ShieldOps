'use strict';

// Thin Kubernetes inspect/manage service. Shells out to `kubectl` (mounted into
// the container) using the KUBECONFIG env (internal kind kubeconfig). Only the
// two demo namespaces are ever touched; callers validate names before calling.

const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

const KUBECTL = 'kubectl';

function kc(args, timeout = 12000) {
  return execFileAsync(KUBECTL, args, { timeout, maxBuffer: 8 * 1024 * 1024 });
}

/** Distil deployments + pods + services in a namespace into a compact shape. */
async function getWorkloads(namespace) {
  const [depRaw, podRaw, svcRaw, nodeRaw] = await Promise.all([
    kc(['get', 'deploy', '-n', namespace, '-o', 'json']),
    kc(['get', 'pods', '-n', namespace, '-o', 'json']),
    kc(['get', 'svc', '-n', namespace, '-o', 'json']),
    kc(['get', 'nodes', '-o', 'jsonpath={.items[0].status.addresses[?(@.type=="InternalIP")].address}']),
  ]);
  const dep = JSON.parse(depRaw.stdout);
  const pods = JSON.parse(podRaw.stdout);
  const svc = JSON.parse(svcRaw.stdout);
  const nodeIp = (nodeRaw.stdout || '').trim() || null;

  return {
    nodeIp,
    deployments: dep.items.map(d => ({
      name:     d.metadata.name,
      replicas: d.status.replicas || 0,
      ready:    d.status.readyReplicas || 0,
      image:    (d.spec.template.spec.containers[0] || {}).image || null,
      revision: (d.metadata.annotations || {})['deployment.kubernetes.io/revision'] || null,
    })),
    pods: pods.items.map(p => {
      const cs = p.status.containerStatuses || [];
      return {
        name:     p.metadata.name,
        phase:    p.status.phase,
        ready:    cs.length > 0 && cs.every(c => c.ready),
        restarts: cs.reduce((a, c) => a + (c.restartCount || 0), 0),
        startedAt: p.status.startTime || null,
        node:     p.spec.nodeName || null,
      };
    }),
    services: svc.items.map(s => ({
      name:     s.metadata.name,
      type:     s.spec.type,
      port:     (s.spec.ports || [])[0] ? s.spec.ports[0].port : null,
      nodePort: (s.spec.ports || []).map(p => p.nodePort).filter(Boolean)[0] || null,
    })),
  };
}

async function restart(namespace, deployment) {
  await kc(['rollout', 'restart', `deploy/${deployment}`, '-n', namespace], 20000);
  return { ok: true, action: 'restart', deployment };
}

async function scale(namespace, deployment, replicas) {
  const r = Math.max(0, Math.min(10, parseInt(replicas, 10) || 0));
  await kc(['scale', `deploy/${deployment}`, '-n', namespace, `--replicas=${r}`], 20000);
  return { ok: true, action: 'scale', deployment, replicas: r };
}

async function rollback(namespace, deployment) {
  await kc(['rollout', 'undo', `deploy/${deployment}`, '-n', namespace], 20000);
  return { ok: true, action: 'rollback', deployment };
}

async function logs(namespace, deployment, lines = 120) {
  const n = Math.max(1, Math.min(1000, parseInt(lines, 10) || 120));
  const { stdout } = await kc(
    ['logs', `deploy/${deployment}`, '-n', namespace, `--tail=${n}`, '--all-containers=true', '--prefix=true'], 15000);
  return stdout;
}

module.exports = { getWorkloads, restart, scale, rollback, logs };
