import React, { useEffect, useState } from 'react';
import StatusBadge from '../components/StatusBadge.jsx';
import {
  fetchCluster, restartDeploy, scaleDeploy, rollbackDeploy, fetchDeployLogs,
} from '../api/client.js';

const ENVS = ['staging', 'production'];

function age(iso) {
  if (!iso) return '—';
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60)    return `${Math.floor(s)}s`;
  if (s < 3600)  return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

const btn = {
  background: 'none', border: '1px solid var(--border)', color: 'var(--text)',
  cursor: 'pointer', padding: '3px 8px', borderRadius: 4, font: 'inherit', fontSize: 11,
};

function EnvCard({ ns }) {
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);
  const [busy, setBusy]       = useState(null);     // "deploy:action" in flight
  const [msg, setMsg]         = useState(null);
  const [scaleVals, setScaleVals] = useState({});   // { deployName: replicas }
  const [logs, setLogs]       = useState(null);     // { name, text } or null

  async function load() {
    try {
      const d = await fetchCluster(ns);
      setData(d); setError(null);
      const sv = {}; (d.deployments || []).forEach(x => { sv[x.name] = x.replicas; });
      setScaleVals(sv);
    } catch (e) { setError(e.response?.data?.error || e.message); }
    finally { setLoading(false); }
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [ns]);

  async function act(deploy, label, fn) {
    setBusy(`${deploy}:${label}`); setMsg(null);
    try { const r = await fn(); setMsg(`${deploy} — ${label}: ${r.action || 'done'}${r.replicas != null ? ' → ' + r.replicas : ''}`); await load(); }
    catch (e) { setMsg(`${deploy} — ${label} failed: ${e.response?.data?.error || e.message}`); }
    finally { setBusy(null); }
  }
  async function showLogs(deploy) {
    setLogs({ name: deploy, text: 'Loading…' });
    try { setLogs({ name: deploy, text: await fetchDeployLogs(ns, deploy) }); }
    catch (e) { setLogs({ name: deploy, text: 'Error: ' + (e.response?.data?.error || e.message) }); }
  }

  const deps = data?.deployments || [];
  const svc  = data?.services?.find(s => s.nodePort) || data?.services?.[0];
  const appUrl = data?.nodeIp && svc?.nodePort ? `http://${data.nodeIp}:${svc.nodePort}` : null;
  const allReady = deps.length > 0 && deps.every(d => d.ready === d.replicas && d.replicas > 0);

  return (
    <div className="card">
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
        <div style={{ fontWeight: 600, textTransform: 'capitalize' }}>{ns}</div>
        {deps.length > 0 && <StatusBadge status={allReady ? 'success' : 'running'} />}
        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{deps.length} workloads</span>
        {appUrl && <a href={appUrl} target="_blank" rel="noreferrer" style={{ marginLeft: 'auto', fontSize: 13 }}>↗ Open app ({svc.nodePort})</a>}
        <button style={{ ...btn, marginLeft: appUrl ? 8 : 'auto' }} onClick={load} disabled={loading}>↻</button>
      </div>

      {loading && <span className="spinner" />}
      {error && <div className="error-msg">{error}</div>}

      {/* AWS (LocalStack) deploy relation — namespace level */}
      {data?.aws && (
        <div style={{ background: '#0a0d14', border: '1px solid var(--border)', borderRadius: 6, padding: '8px 12px', marginBottom: 12, fontSize: 13 }}>
          ☁️ <strong>AWS (LocalStack) deploy:</strong> <StatusBadge status={data.aws.status} />{' '}
          {data.aws.web_url
            ? <a href={`${data.aws.web_url}/-/pipelines/${data.aws.pipeline_id}`} target="_blank" rel="noreferrer">pipeline #{data.aws.pipeline_id} ↗</a>
            : <>pipeline #{data.aws.pipeline_id}</>}
          <div style={{ color: 'var(--text-muted)', fontSize: 12, marginTop: 4 }}>
            g9 published this release to S3 + Secrets Manager (ECR substitute).
          </div>
        </div>
      )}

      {/* Deployments with per-workload controls */}
      {deps.length > 0 && (
        <table style={{ marginBottom: 12 }}>
          <thead><tr><th>Workload</th><th>Image</th><th>Ready</th><th>Manage</th></tr></thead>
          <tbody>
            {deps.map(d => (
              <tr key={d.name}>
                <td><code style={{ fontSize: 12 }}>{d.name}</code></td>
                <td><code style={{ fontSize: 11, color: 'var(--text-muted)' }}>{(d.image || '').split('/').pop()}</code></td>
                <td style={{ color: d.ready === d.replicas && d.replicas > 0 ? 'var(--success)' : 'var(--danger)' }}>{d.ready}/{d.replicas}</td>
                <td>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
                    <button style={btn} disabled={!!busy} onClick={() => act(d.name, 'Restart', () => restartDeploy(ns, d.name))}>↻</button>
                    <input type="number" min={0} max={10} value={scaleVals[d.name] ?? d.replicas}
                      onChange={e => setScaleVals(v => ({ ...v, [d.name]: e.target.value }))}
                      style={{ width: 42, padding: '2px 4px' }} />
                    <button style={btn} disabled={!!busy} onClick={() => act(d.name, 'Scale', () => scaleDeploy(ns, d.name, scaleVals[d.name] ?? d.replicas))}>Scale</button>
                    <button style={btn} disabled={!!busy} onClick={() => { if (window.confirm(`Roll back ${d.name}?`)) act(d.name, 'Rollback', () => rollbackDeploy(ns, d.name)); }}>⟲</button>
                    <button style={btn} disabled={!!busy} onClick={() => showLogs(d.name)}>📜</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {busy && <span className="spinner" />}
      {msg && <div style={{ fontSize: 12, color: msg.includes('failed') ? 'var(--danger)' : 'var(--success)', marginBottom: 8 }}>{msg}</div>}

      {/* Pods */}
      {deps.length > 0 && (
        <>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', margin: '8px 0 4px' }}>Pods ({data.pods.length})</div>
          <table>
            <thead><tr><th>Pod</th><th>Phase</th><th>Ready</th><th>Restarts</th><th>Age</th></tr></thead>
            <tbody>
              {data.pods.map(p => (
                <tr key={p.name}>
                  <td><code style={{ fontSize: 11 }}>{p.name}</code></td>
                  <td><StatusBadge status={p.phase === 'Running' ? 'success' : p.phase.toLowerCase()} /></td>
                  <td>{p.ready ? '✅' : '⏳'}</td>
                  <td style={{ color: p.restarts > 5 ? 'var(--danger)' : undefined }}>{p.restarts}</td>
                  <td>{age(p.startedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {logs && (
        <div style={{ marginTop: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Logs — {logs.name}</div>
            <button style={{ ...btn, marginLeft: 'auto' }} onClick={() => setLogs(null)}>Close</button>
          </div>
          <pre style={{ maxHeight: 280, overflow: 'auto', background: '#0a0d14', border: '1px solid var(--border)', borderRadius: 4, padding: 10, fontSize: 11, marginTop: 6, whiteSpace: 'pre-wrap' }}>{logs.text}</pre>
        </div>
      )}

      {!loading && !error && deps.length === 0 && <div style={{ color: 'var(--text-muted)' }}>No app deployed in {ns}.</div>}
    </div>
  );
}

export default function ClusterPage() {
  return (
    <div className="page">
      <div className="page-title">App Inspector — Deployed App (kind)</div>
      <div style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 16 }}>
        Live status and management for the app running on Kubernetes, with its AWS (LocalStack) deploy link.
      </div>
      <div className="grid-2">
        {ENVS.map(ns => <EnvCard key={ns} ns={ns} />)}
      </div>
    </div>
  );
}
