import React, { useEffect, useState } from 'react';
import { Link }    from 'react-router-dom';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from 'recharts';
import { fetchPipelines } from '../api/client.js';
import StatusBadge from '../components/StatusBadge.jsx';

function timeAgo(dateStr) {
  if (!dateStr) return '—';
  const diff = Date.now() - new Date(dateStr).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1)  return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export default function DashboardPage() {
  const [pipelines, setPipelines] = useState([]);
  const [loading,   setLoading]   = useState(true);
  const [error,     setError]     = useState(null);

  async function load() {
    try {
      setError(null);
      const data = await fetchPipelines();
      setPipelines(data);
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, []);

  // Chart data: last 20 pipelines pass/fail
  const chartData = [...pipelines].slice(0, 20).reverse().map(p => ({
    name:   `#${p.gitlab_pipeline_id}`,
    passed: parseInt(p.gates_passed) || 0,
    failed: parseInt(p.gates_failed) || 0,
  }));

  const totalPass   = pipelines.filter(p => p.status === 'success').length;
  const totalFail   = pipelines.filter(p => p.status === 'failed').length;
  const totalRun    = pipelines.filter(p => p.status === 'running').length;

  return (
    <div className="page">
      <div className="page-title">Pipeline Dashboard</div>

      <div className="grid-3" style={{ marginBottom: 20 }}>
        <div className="card" style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 32, fontWeight: 700, color: 'var(--success)' }}>{totalPass}</div>
          <div style={{ color: 'var(--text-muted)' }}>Passed</div>
        </div>
        <div className="card" style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 32, fontWeight: 700, color: 'var(--danger)' }}>{totalFail}</div>
          <div style={{ color: 'var(--text-muted)' }}>Failed</div>
        </div>
        <div className="card" style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 32, fontWeight: 700, color: 'var(--info)' }}>{totalRun}</div>
          <div style={{ color: 'var(--text-muted)' }}>Running</div>
        </div>
      </div>

      {chartData.length > 0 && (
        <div className="card" style={{ marginBottom: 20 }}>
          <div style={{ fontWeight: 600, marginBottom: 12 }}>Gate Results — Recent Pipelines</div>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={chartData}>
              <XAxis dataKey="name" stroke="#94a3b8" tick={{ fontSize: 11 }} />
              <YAxis stroke="#94a3b8" tick={{ fontSize: 11 }} />
              <Tooltip
                contentStyle={{ background: '#1a1d27', border: '1px solid #2d3147', borderRadius: 6 }}
                labelStyle={{ color: '#e2e8f0' }}
              />
              <Bar dataKey="passed" fill="#22c55e" name="Passed" radius={[3, 3, 0, 0]} />
              <Bar dataKey="failed" fill="#ef4444" name="Failed" radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {loading && <div style={{ color: 'var(--text-muted)' }}>Loading pipelines… <span className="spinner" /></div>}
      {error   && <div className="error-msg">{error}</div>}

      {!loading && (
        <div className="card" style={{ padding: 0 }}>
          <table>
            <thead>
              <tr>
                <th>Pipeline</th>
                <th>Branch</th>
                <th>Status</th>
                <th>Gates</th>
                <th>Deploy</th>
                <th>When</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {pipelines.length === 0 && (
                <tr><td colSpan={7} style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 30 }}>
                  No pipelines yet. Configure the GitLab webhook to start receiving events.
                </td></tr>
              )}
              {pipelines.map(p => (
                <tr key={p.id}>
                  <td><Link to={`/pipelines/${p.id}`}>#{p.gitlab_pipeline_id}</Link></td>
                  <td><code style={{ fontSize: 12 }}>{p.branch}</code></td>
                  <td><StatusBadge status={p.status} /></td>
                  <td>
                    <span style={{ color: 'var(--success)' }}>{p.gates_passed || 0}</span>
                    {' / '}
                    <span style={{ color: 'var(--text-muted)' }}>{p.gates_total || 0}</span>
                    {p.gates_failed > 0 && <span style={{ color: 'var(--danger)', marginLeft: 4 }}>({p.gates_failed} failed)</span>}
                  </td>
                  <td>{p.deploy_status ? <StatusBadge status={p.deploy_status} /> : <span style={{ color: 'var(--text-muted)' }}>—</span>}</td>
                  <td style={{ color: 'var(--text-muted)' }}>{timeAgo(p.created_at)}</td>
                  <td>
                    <Link to={`/pipelines/${p.id}`} style={{ fontSize: 12 }}>Detail →</Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
